// 仅用于开发测试：在 Linux/Mono 上用 HttpListener 承载 api/scenarios.ashx 并提供静态文件。生产环境请使用 IIS。
// 编译：mcs -langversion:5 -r:System.Web -r:System.Data -r:System.Configuration -out:TestHost.exe api.cs TestHost.cs
//（api.cs = scenarios.ashx 去掉第一行 <%@ WebHandler %> 指令）
using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Web;

class ListenerWorkerRequest : HttpWorkerRequest
{
    private readonly HttpListenerContext lc;
    private readonly byte[] body;
    public readonly MemoryStream Output = new MemoryStream();
    public int Status = 200;

    public ListenerWorkerRequest(HttpListenerContext c, byte[] b) { lc = c; body = b; }
    public override string GetUriPath() { return lc.Request.Url.AbsolutePath; }
    public override string GetQueryString() { string q = lc.Request.Url.Query; return q.StartsWith("?") ? q.Substring(1) : q; }
    public override string GetRawUrl() { return lc.Request.RawUrl; }
    public override string GetHttpVerbName() { return lc.Request.HttpMethod; }
    public override string GetHttpVersion() { return "HTTP/1.0"; }
    public override string GetRemoteAddress() { return lc.Request.RemoteEndPoint.Address.ToString(); }
    public override int GetRemotePort() { return lc.Request.RemoteEndPoint.Port; }
    public override string GetLocalAddress() { return "127.0.0.1"; }
    public override int GetLocalPort() { return lc.Request.Url.Port; }
    public override string GetServerVariable(string name) { return null; }
    public override string GetKnownRequestHeader(int index) { return lc.Request.Headers[GetKnownRequestHeaderName(index)]; }
    public override string GetUnknownRequestHeader(string name) { return lc.Request.Headers[name]; }
    public override string[][] GetUnknownRequestHeaders()
    {
        List<string[]> l = new List<string[]>();
        foreach (string k in lc.Request.Headers.AllKeys)
            if (GetKnownRequestHeaderIndex(k) < 0) l.Add(new string[] { k, lc.Request.Headers[k] });
        return l.ToArray();
    }
    public override byte[] GetPreloadedEntityBody() { return body; }
    public override int GetPreloadedEntityBodyLength() { return body.Length; }
    public override int GetTotalEntityBodyLength() { return body.Length; }
    public override bool IsEntireEntityBodyIsPreloaded() { return true; }
    public override int ReadEntityBody(byte[] buffer, int size) { return 0; }
    public override void SendStatus(int statusCode, string statusDescription) { Status = statusCode; }
    public override void SendKnownResponseHeader(int index, string value) { }
    public override void SendUnknownResponseHeader(string name, string value) { }
    public override void SendResponseFromMemory(byte[] data, int length) { Output.Write(data, 0, length); }
    public override void SendResponseFromFile(string filename, long offset, long length) { }
    public override void SendResponseFromFile(IntPtr handle, long offset, long length) { }
    public override void FlushResponse(bool finalFlush) { }
    public override void EndOfRequest() { }
}

class TestHost
{
    static readonly Dictionary<string, string> Mime = new Dictionary<string, string> {
        {".html","text/html; charset=utf-8"},{".js","application/javascript; charset=utf-8"},{".css","text/css; charset=utf-8"},
        {".svg","image/svg+xml"},{".woff2","font/woff2"},{".json","application/json"},{".txt","text/plain; charset=utf-8"} };

    static void Main(string[] args)
    {
        string root = Path.GetFullPath(args[0]);
        string prefix = args.Length > 1 ? args[1] : "http://127.0.0.1:8099/";
        HttpListener l = new HttpListener();
        l.Prefixes.Add(prefix);
        l.Start();
        Console.WriteLine("listening " + prefix + " root " + root);
        while (true)
        {
            HttpListenerContext c = l.GetContext();
            try { Handle(c, root); }
            catch (Exception ex) { Console.WriteLine("ERR " + ex); try { c.Response.StatusCode = 500; c.Response.Close(); } catch { } }
        }
    }

    static void Handle(HttpListenerContext c, string root)
    {
        string path = Uri.UnescapeDataString(c.Request.Url.AbsolutePath);
        if (path.EndsWith("/api/scenarios.ashx", StringComparison.OrdinalIgnoreCase))
        {
            MemoryStream ms = new MemoryStream();
            c.Request.InputStream.CopyTo(ms);
            ListenerWorkerRequest wr = new ListenerWorkerRequest(c, ms.ToArray());
            HttpContext ctx = new HttpContext(wr);
            new LogiSimScenarioApi().ProcessRequest(ctx);
            ctx.Response.Flush();
            byte[] outb = wr.Output.ToArray();
            c.Response.StatusCode = ctx.Response.StatusCode;
            c.Response.ContentType = "application/json; charset=utf-8";
            c.Response.ContentLength64 = outb.Length;
            c.Response.OutputStream.Write(outb, 0, outb.Length);
            c.Response.Close();
            Console.WriteLine(c.Request.HttpMethod + " " + c.Request.RawUrl + " -> " + ctx.Response.StatusCode);
            return;
        }
        if (path.EndsWith("/")) path += "index.html";
        string full = Path.GetFullPath(Path.Combine(root, path.TrimStart('/')));
        if (!full.StartsWith(root) || full.Contains("App_Data") || !File.Exists(full)) { c.Response.StatusCode = 404; c.Response.Close(); return; }
        byte[] b = File.ReadAllBytes(full);
        string ct;
        c.Response.ContentType = Mime.TryGetValue(Path.GetExtension(full), out ct) ? ct : "application/octet-stream";
        c.Response.ContentLength64 = b.Length;
        c.Response.OutputStream.Write(b, 0, b.Length);
        c.Response.Close();
    }
}
