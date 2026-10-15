<%@ WebHandler Language="C#" Class="LogiSimScenarioApi" %>
// 场内物流 3D 仿真台 · 方案存储 API
// IIS 首次访问时自动编译（.NET Framework 4.5+，无需 Visual Studio 构建）。
// 存储方式在 web.config <appSettings> 中配置：
//   LogiSim.Storage  = File（默认，JSON 文件）| SqlServer
//   LogiSim.DataPath = ~/App_Data/scenarios 或 \\fileserver\share\logisim（File 模式）
//   connectionStrings: LogiSim（SqlServer 模式）
// 接口（全部返回 JSON，写操作只接受 POST 且需带请求头 X-LogiSim-Client）：
//   GET  ?action=health              服务状态、存储方式、当前用户
//   GET  ?action=list                方案列表（含最近一次仿真结果摘要）
//   GET  ?action=get&id=             读取方案
//   POST ?action=save&id=&rev=&name= 保存方案（rev=-1 新建；rev 不一致返回 409）
//   POST ?action=result&id=          保存仿真结果摘要
//   POST ?action=delete&id=&rev=     删除方案
// 注意：本文件按 C# 5 语法编写，以兼容 IIS 运行时编译器。

using System;
using System.Collections.Generic;
using System.Configuration;
using System.Data;
using System.Data.SqlClient;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Web;

public class LogiSimScenarioApi : IHttpHandler
{
    public const string ApiVersion = "1.1.0";
    private static readonly Regex IdPattern = new Regex("^[A-Za-z0-9_-]{1,64}$");

    public bool IsReusable { get { return true; } }

    public void ProcessRequest(HttpContext ctx)
    {
        HttpResponse res = ctx.Response;
        res.ContentType = "application/json";
        res.ContentEncoding = new UTF8Encoding(false);
        res.Cache.SetCacheability(HttpCacheability.NoCache);
        res.Cache.SetNoStore();
        res.TrySkipIisCustomErrors = true;
        res.AppendHeader("X-Content-Type-Options", "nosniff");

        string action = (ctx.Request.QueryString["action"] ?? "list").Trim().ToLowerInvariant();
        bool isPost = string.Equals(ctx.Request.HttpMethod, "POST", StringComparison.OrdinalIgnoreCase);
        bool writeAction = action == "save" || action == "result" || action == "delete";

        try
        {
            if (writeAction)
            {
                if (!isPost) { Fail(ctx, 405, "写操作只接受 POST 请求"); return; }
                if (string.IsNullOrEmpty(ctx.Request.Headers["X-LogiSim-Client"])) { Fail(ctx, 403, "缺少客户端标识请求头"); return; }
            }

            IScenarioStore store = StoreFactory.Create(ctx);
            string user = UserName(ctx);

            if (action == "health")
            {
                store.EnsureReady();
                Send(ctx, 200, "{\"ok\":true,\"version\":" + Json.Str(ApiVersion) + ",\"storage\":" + Json.Str(store.Kind) +
                    ",\"user\":" + Json.Str(user) + ",\"time\":" + Json.Str(Json.Date(DateTime.UtcNow)) + "}");
                return;
            }

            store.EnsureReady();

            if (action == "list")
            {
                List<ScenarioMeta> items = store.List();
                StringBuilder sb = new StringBuilder("{\"ok\":true,\"items\":[");
                for (int i = 0; i < items.Count; i++)
                {
                    if (i > 0) sb.Append(',');
                    sb.Append('{');
                    AppendMeta(sb, items[i]);
                    sb.Append('}');
                }
                sb.Append("]}");
                Send(ctx, 200, sb.ToString());
                return;
            }

            string id = ctx.Request.QueryString["id"] ?? "";
            if (!IdPattern.IsMatch(id)) { Fail(ctx, 400, "方案编号不合法"); return; }

            if (action == "get")
            {
                ScenarioRecord rec = store.Get(id);
                if (rec == null) { Fail(ctx, 404, "方案不存在或已被删除"); return; }
                StringBuilder sb = new StringBuilder("{\"ok\":true,");
                AppendMeta(sb, rec);
                sb.Append(",\"data\":").Append(rec.Data).Append('}');
                Send(ctx, 200, sb.ToString());
                return;
            }

            if (action == "save")
            {
                string body = ReadBody(ctx);
                if (!Json.LooksLikeObject(body)) { Fail(ctx, 400, "请求内容不是有效的方案 JSON"); return; }
                string name = (ctx.Request.QueryString["name"] ?? "").Trim();
                if (name.Length == 0) name = "未命名方案";
                if (name.Length > 200) name = name.Substring(0, 200);
                int baseRev = ParseInt(ctx.Request.QueryString["rev"], -1);
                SaveOutcome r = store.Save(id, name, body, baseRev, user);
                if (!r.Ok)
                {
                    Send(ctx, 409, "{\"ok\":false,\"conflict\":true,\"error\":" + Json.Str("方案已被其他人修改") + ",\"rev\":" + r.Rev +
                        ",\"updated\":" + Json.Str(Json.Date(r.Updated)) + ",\"updatedBy\":" + Json.Str(r.UpdatedBy) + "}");
                    return;
                }
                Send(ctx, 200, "{\"ok\":true,\"rev\":" + r.Rev + ",\"updated\":" + Json.Str(Json.Date(r.Updated)) + ",\"updatedBy\":" + Json.Str(r.UpdatedBy) + "}");
                return;
            }

            if (action == "result")
            {
                string body = ReadBody(ctx);
                if (!Json.LooksLikeObject(body) || body.Length > 200000) { Fail(ctx, 400, "仿真结果格式不正确"); return; }
                if (!store.SaveResult(id, body)) { Fail(ctx, 404, "方案不存在或已被删除"); return; }
                Send(ctx, 200, "{\"ok\":true}");
                return;
            }

            if (action == "delete")
            {
                int baseRev = ParseInt(ctx.Request.QueryString["rev"], -1);
                store.Delete(id, baseRev);
                Send(ctx, 200, "{\"ok\":true}");
                return;
            }

            Fail(ctx, 400, "未知的 action：" + action);
        }
        catch (Exception ex)
        {
            string msg = ex.Message;
            if (ex is UnauthorizedAccessException) msg = "存储目录没有写入权限，请为 IIS 应用程序池账号授予修改权限。" + ex.Message;
            else if (ex is SqlException) msg = "数据库访问失败：" + ex.Message;
            Fail(ctx, 500, msg);
        }
    }

    // 只写字段，不含花括号：list 中每项外加 {}，get 中后面还要接 data 字段
    private static void AppendMeta(StringBuilder sb, ScenarioMeta m)
    {
        sb.Append("\"id\":").Append(Json.Str(m.Id))
          .Append(",\"name\":").Append(Json.Str(m.Name))
          .Append(",\"rev\":").Append(m.Rev.ToString(CultureInfo.InvariantCulture))
          .Append(",\"updated\":").Append(Json.Str(Json.Date(m.Updated)))
          .Append(",\"updatedBy\":").Append(Json.Str(m.UpdatedBy))
          .Append(",\"size\":").Append(m.Size.ToString(CultureInfo.InvariantCulture))
          .Append(",\"result\":").Append(Json.LooksLikeObject(m.Result) ? m.Result : "null");
    }

    private static string ReadBody(HttpContext ctx)
    {
        using (StreamReader reader = new StreamReader(ctx.Request.InputStream, Encoding.UTF8))
        {
            return reader.ReadToEnd();
        }
    }

    private static int ParseInt(string s, int fallback)
    {
        int v;
        return int.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out v) ? v : fallback;
    }

    private static string UserName(HttpContext ctx)
    {
        if (ctx.User != null && ctx.User.Identity != null && ctx.User.Identity.IsAuthenticated && !string.IsNullOrEmpty(ctx.User.Identity.Name))
            return ctx.User.Identity.Name;
        // 取用户名失败不应影响读写方案
        try
        {
            string logon = ctx.Request.ServerVariables["LOGON_USER"];
            if (!string.IsNullOrEmpty(logon)) return logon;
        }
        catch (Exception) { }
        string ip = "";
        try { ip = ctx.Request.UserHostAddress ?? ""; } catch (Exception) { }
        return "访客 " + ip;
    }

    private static void Send(HttpContext ctx, int status, string json)
    {
        ctx.Response.StatusCode = status;
        ctx.Response.Write(json);
    }

    private static void Fail(HttpContext ctx, int status, string message)
    {
        Send(ctx, status, "{\"ok\":false,\"error\":" + Json.Str(message) + "}");
    }
}

// ---------------------------------------------------------------- models
public class ScenarioMeta
{
    public string Id;
    public string Name;
    public int Rev;
    public DateTime Updated;
    public string UpdatedBy;
    public long Size;
    public string Result;
}

public class ScenarioRecord : ScenarioMeta
{
    public string Data;
}

public class SaveOutcome
{
    public bool Ok;
    public int Rev;
    public DateTime Updated;
    public string UpdatedBy;
}

public interface IScenarioStore
{
    string Kind { get; }
    void EnsureReady();
    List<ScenarioMeta> List();
    ScenarioRecord Get(string id);
    SaveOutcome Save(string id, string name, string data, int baseRev, string user);
    bool SaveResult(string id, string result);
    void Delete(string id, int baseRev);
}

public static class StoreFactory
{
    public static IScenarioStore Create(HttpContext ctx)
    {
        string kind = (ConfigurationManager.AppSettings["LogiSim.Storage"] ?? "File").Trim();
        if (string.Equals(kind, "SqlServer", StringComparison.OrdinalIgnoreCase))
        {
            ConnectionStringSettings cs = ConfigurationManager.ConnectionStrings["LogiSim"];
            if (cs == null || string.IsNullOrEmpty(cs.ConnectionString))
                throw new ConfigurationErrorsException("web.config 中缺少名为 LogiSim 的数据库连接字符串");
            return new SqlScenarioStore(cs.ConnectionString);
        }
        string path = (ConfigurationManager.AppSettings["LogiSim.DataPath"] ?? "~/App_Data/scenarios").Trim();
        if (path.StartsWith("~")) path = ctx.Server.MapPath(path);
        return new FileScenarioStore(path);
    }
}

// ---------------------------------------------------------------- file storage
// 每个方案 3 个文件：{id}.json（方案数据）、{id}.meta（元信息）、{id}.result.json（最近一次仿真结果）
public class FileScenarioStore : IScenarioStore
{
    private static readonly object Gate = new object();
    private static readonly Encoding Utf8 = new UTF8Encoding(false);
    private readonly string dir;

    public FileScenarioStore(string dir) { this.dir = dir; }

    public string Kind { get { return "File"; } }

    public void EnsureReady()
    {
        if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);
    }

    private string P(string id, string ext) { return Path.Combine(dir, id + ext); }

    public List<ScenarioMeta> List()
    {
        List<ScenarioMeta> list = new List<ScenarioMeta>();
        lock (Gate)
        {
            foreach (string f in Directory.GetFiles(dir, "*.meta"))
            {
                ScenarioMeta m = ReadMeta(Path.GetFileNameWithoutExtension(f));
                if (m != null) list.Add(m);
            }
        }
        list.Sort(delegate (ScenarioMeta a, ScenarioMeta b) { return b.Updated.CompareTo(a.Updated); });
        return list;
    }

    private ScenarioMeta ReadMeta(string id)
    {
        string mp = P(id, ".meta");
        if (!File.Exists(mp)) return null;
        ScenarioMeta m = new ScenarioMeta();
        m.Id = id;
        foreach (string line in File.ReadAllLines(mp, Utf8))
        {
            int eq = line.IndexOf('=');
            if (eq <= 0) continue;
            string k = line.Substring(0, eq);
            string v = Uri.UnescapeDataString(line.Substring(eq + 1));
            if (k == "name") m.Name = v;
            else if (k == "rev") int.TryParse(v, NumberStyles.Integer, CultureInfo.InvariantCulture, out m.Rev);
            else if (k == "updated") DateTime.TryParse(v, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out m.Updated);
            else if (k == "updatedBy") m.UpdatedBy = v;
            else if (k == "size") long.TryParse(v, NumberStyles.Integer, CultureInfo.InvariantCulture, out m.Size);
        }
        string rp = P(id, ".result.json");
        if (File.Exists(rp)) m.Result = File.ReadAllText(rp, Utf8);
        return m;
    }

    private void WriteMeta(ScenarioMeta m)
    {
        StringBuilder sb = new StringBuilder();
        sb.Append("name=").Append(Uri.EscapeDataString(m.Name ?? "")).Append("\r\n");
        sb.Append("rev=").Append(m.Rev.ToString(CultureInfo.InvariantCulture)).Append("\r\n");
        sb.Append("updated=").Append(Uri.EscapeDataString(Json.Date(m.Updated))).Append("\r\n");
        sb.Append("updatedBy=").Append(Uri.EscapeDataString(m.UpdatedBy ?? "")).Append("\r\n");
        sb.Append("size=").Append(m.Size.ToString(CultureInfo.InvariantCulture)).Append("\r\n");
        AtomicWrite(P(m.Id, ".meta"), sb.ToString());
    }

    private static void AtomicWrite(string path, string content)
    {
        string tmp = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        File.WriteAllText(tmp, content, Utf8);
        File.Copy(tmp, path, true);
        File.Delete(tmp);
    }

    public ScenarioRecord Get(string id)
    {
        lock (Gate)
        {
            ScenarioMeta m = ReadMeta(id);
            string dp = P(id, ".json");
            if (m == null || !File.Exists(dp)) return null;
            ScenarioRecord r = new ScenarioRecord();
            r.Id = m.Id; r.Name = m.Name; r.Rev = m.Rev; r.Updated = m.Updated; r.UpdatedBy = m.UpdatedBy; r.Size = m.Size; r.Result = m.Result;
            r.Data = File.ReadAllText(dp, Utf8);
            return r;
        }
    }

    public SaveOutcome Save(string id, string name, string data, int baseRev, string user)
    {
        lock (Gate)
        {
            ScenarioMeta cur = ReadMeta(id);
            SaveOutcome o = new SaveOutcome();
            if (cur != null && (baseRev < 0 || baseRev != cur.Rev))
            {
                o.Ok = false; o.Rev = cur.Rev; o.Updated = cur.Updated; o.UpdatedBy = cur.UpdatedBy;
                return o;
            }
            ScenarioMeta m = new ScenarioMeta();
            m.Id = id; m.Name = name; m.Rev = cur == null ? 1 : cur.Rev + 1; m.Updated = DateTime.UtcNow; m.UpdatedBy = user;
            m.Size = Utf8.GetByteCount(data);
            AtomicWrite(P(id, ".json"), data);
            WriteMeta(m);
            o.Ok = true; o.Rev = m.Rev; o.Updated = m.Updated; o.UpdatedBy = m.UpdatedBy;
            return o;
        }
    }

    public bool SaveResult(string id, string result)
    {
        lock (Gate)
        {
            if (!File.Exists(P(id, ".meta"))) return false;
            AtomicWrite(P(id, ".result.json"), result);
            return true;
        }
    }

    public void Delete(string id, int baseRev)
    {
        lock (Gate)
        {
            string[] exts = new string[] { ".json", ".meta", ".result.json" };
            foreach (string e in exts)
            {
                string p = P(id, e);
                if (File.Exists(p)) File.Delete(p);
            }
        }
    }
}

// ---------------------------------------------------------------- SQL Server storage
public class SqlScenarioStore : IScenarioStore
{
    private static volatile bool tableReady;
    private static readonly object InitGate = new object();
    private readonly string cs;

    public SqlScenarioStore(string connectionString) { cs = connectionString; }

    public string Kind { get { return "SqlServer"; } }

    public void EnsureReady()
    {
        if (tableReady) return;
        lock (InitGate)
        {
            if (tableReady) return;
            using (SqlConnection c = Open())
            using (SqlCommand cmd = new SqlCommand(
                "IF OBJECT_ID(N'dbo.LogiSimScenario', N'U') IS NULL " +
                "CREATE TABLE dbo.LogiSimScenario(" +
                " Id NVARCHAR(64) NOT NULL CONSTRAINT PK_LogiSimScenario PRIMARY KEY," +
                " Name NVARCHAR(200) NOT NULL," +
                " Data NVARCHAR(MAX) NOT NULL," +
                " Result NVARCHAR(MAX) NULL," +
                " Rev INT NOT NULL," +
                " UpdatedAt DATETIME2(0) NOT NULL," +
                " UpdatedBy NVARCHAR(128) NULL);", c))
            {
                cmd.ExecuteNonQuery();
            }
            tableReady = true;
        }
    }

    private SqlConnection Open()
    {
        SqlConnection c = new SqlConnection(cs);
        c.Open();
        return c;
    }

    private static SqlParameter Nv(string name, string value, int size)
    {
        SqlParameter p = new SqlParameter(name, SqlDbType.NVarChar, size);
        p.Value = (object)value ?? DBNull.Value;
        return p;
    }

    private static SqlParameter I(string name, int value)
    {
        SqlParameter p = new SqlParameter(name, SqlDbType.Int);
        p.Value = value;
        return p;
    }

    private static ScenarioMeta ReadMeta(SqlDataReader r, ScenarioMeta m)
    {
        m.Id = r.GetString(0);
        m.Name = r.GetString(1);
        m.Rev = r.GetInt32(2);
        m.Updated = DateTime.SpecifyKind(r.GetDateTime(3), DateTimeKind.Utc);
        m.UpdatedBy = r.IsDBNull(4) ? "" : r.GetString(4);
        m.Size = r.IsDBNull(5) ? 0 : Convert.ToInt64(r.GetValue(5), CultureInfo.InvariantCulture);
        m.Result = r.IsDBNull(6) ? null : r.GetString(6);
        return m;
    }

    public List<ScenarioMeta> List()
    {
        List<ScenarioMeta> list = new List<ScenarioMeta>();
        using (SqlConnection c = Open())
        using (SqlCommand cmd = new SqlCommand("SELECT Id, Name, Rev, UpdatedAt, UpdatedBy, DATALENGTH(Data), Result FROM dbo.LogiSimScenario ORDER BY UpdatedAt DESC", c))
        using (SqlDataReader r = cmd.ExecuteReader())
        {
            while (r.Read()) list.Add(ReadMeta(r, new ScenarioMeta()));
        }
        return list;
    }

    public ScenarioRecord Get(string id)
    {
        using (SqlConnection c = Open())
        using (SqlCommand cmd = new SqlCommand("SELECT Id, Name, Rev, UpdatedAt, UpdatedBy, DATALENGTH(Data), Result, Data FROM dbo.LogiSimScenario WHERE Id = @id", c))
        {
            cmd.Parameters.Add(Nv("@id", id, 64));
            using (SqlDataReader r = cmd.ExecuteReader())
            {
                if (!r.Read()) return null;
                ScenarioRecord rec = new ScenarioRecord();
                ReadMeta(r, rec);
                rec.Data = r.GetString(7);
                return rec;
            }
        }
    }

    public SaveOutcome Save(string id, string name, string data, int baseRev, string user)
    {
        SaveOutcome o = new SaveOutcome();
        DateTime now = DateTime.UtcNow;
        now = new DateTime(now.Year, now.Month, now.Day, now.Hour, now.Minute, now.Second, DateTimeKind.Utc);
        using (SqlConnection c = Open())
        {
            int affected;
            if (baseRev < 0)
            {
                using (SqlCommand cmd = new SqlCommand(
                    "IF NOT EXISTS (SELECT 1 FROM dbo.LogiSimScenario WITH (UPDLOCK, HOLDLOCK) WHERE Id = @id) " +
                    "INSERT dbo.LogiSimScenario(Id, Name, Data, Rev, UpdatedAt, UpdatedBy) VALUES(@id, @name, @data, 1, @at, @by);", c))
                {
                    cmd.Parameters.Add(Nv("@id", id, 64));
                    cmd.Parameters.Add(Nv("@name", name, 200));
                    cmd.Parameters.Add(Nv("@data", data, -1));
                    cmd.Parameters.Add(new SqlParameter("@at", SqlDbType.DateTime2) { Value = now });
                    cmd.Parameters.Add(Nv("@by", user, 128));
                    affected = cmd.ExecuteNonQuery();
                }
                if (affected > 0) { o.Ok = true; o.Rev = 1; o.Updated = now; o.UpdatedBy = user; return o; }
            }
            else
            {
                using (SqlCommand cmd = new SqlCommand(
                    "UPDATE dbo.LogiSimScenario SET Name = @name, Data = @data, Rev = Rev + 1, UpdatedAt = @at, UpdatedBy = @by WHERE Id = @id AND Rev = @rev;", c))
                {
                    cmd.Parameters.Add(Nv("@id", id, 64));
                    cmd.Parameters.Add(Nv("@name", name, 200));
                    cmd.Parameters.Add(Nv("@data", data, -1));
                    cmd.Parameters.Add(new SqlParameter("@at", SqlDbType.DateTime2) { Value = now });
                    cmd.Parameters.Add(Nv("@by", user, 128));
                    cmd.Parameters.Add(I("@rev", baseRev));
                    affected = cmd.ExecuteNonQuery();
                }
                if (affected > 0) { o.Ok = true; o.Rev = baseRev + 1; o.Updated = now; o.UpdatedBy = user; return o; }
            }
            using (SqlCommand cmd = new SqlCommand("SELECT Rev, UpdatedAt, UpdatedBy FROM dbo.LogiSimScenario WHERE Id = @id", c))
            {
                cmd.Parameters.Add(Nv("@id", id, 64));
                using (SqlDataReader r = cmd.ExecuteReader())
                {
                    o.Ok = false;
                    if (r.Read())
                    {
                        o.Rev = r.GetInt32(0);
                        o.Updated = DateTime.SpecifyKind(r.GetDateTime(1), DateTimeKind.Utc);
                        o.UpdatedBy = r.IsDBNull(2) ? "" : r.GetString(2);
                    }
                    else { o.Rev = 0; o.Updated = now; o.UpdatedBy = "（已被删除）"; }
                }
            }
            return o;
        }
    }

    public bool SaveResult(string id, string result)
    {
        using (SqlConnection c = Open())
        using (SqlCommand cmd = new SqlCommand("UPDATE dbo.LogiSimScenario SET Result = @r WHERE Id = @id", c))
        {
            cmd.Parameters.Add(Nv("@id", id, 64));
            cmd.Parameters.Add(Nv("@r", result, -1));
            return cmd.ExecuteNonQuery() > 0;
        }
    }

    public void Delete(string id, int baseRev)
    {
        using (SqlConnection c = Open())
        using (SqlCommand cmd = new SqlCommand("DELETE FROM dbo.LogiSimScenario WHERE Id = @id", c))
        {
            cmd.Parameters.Add(Nv("@id", id, 64));
            cmd.ExecuteNonQuery();
        }
    }
}

// ---------------------------------------------------------------- JSON helpers
public static class Json
{
    public static string Str(string s)
    {
        if (s == null) return "null";
        StringBuilder sb = new StringBuilder(s.Length + 2);
        sb.Append('"');
        foreach (char ch in s)
        {
            switch (ch)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                case '<': sb.Append("\\u003c"); break;
                case '>': sb.Append("\\u003e"); break;
                case '\u2028': sb.Append("\\u2028"); break;
                case '\u2029': sb.Append("\\u2029"); break;
                default:
                    if (ch < ' ') sb.Append("\\u").Append(((int)ch).ToString("x4", CultureInfo.InvariantCulture));
                    else sb.Append(ch);
                    break;
            }
        }
        sb.Append('"');
        return sb.ToString();
    }

    public static string Date(DateTime d)
    {
        if (d == DateTime.MinValue) return "";
        return d.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture);
    }

    public static bool LooksLikeObject(string s)
    {
        if (string.IsNullOrEmpty(s)) return false;
        string t = s.Trim();
        return t.Length >= 2 && t[0] == '{' && t[t.Length - 1] == '}';
    }
}
