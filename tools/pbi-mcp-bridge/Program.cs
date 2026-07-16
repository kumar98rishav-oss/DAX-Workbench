using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using ModelContextProtocol; // MCP C# SDK (preview) — AddMcpServer / WithStdioServerTransport

// PBI MCP Bridge — a Model Context Protocol server that connects to the live
// Power BI Desktop model (local Analysis Services) so the Studio and Claude can
// read the real schema, run DAX against real data, and push measures straight in.
//
// Transport is stdio: stdout carries the MCP protocol, so all logging goes to
// stderr (the SDK + this config keep stdout clean).

var builder = Host.CreateApplicationBuilder(args);

builder.Logging.AddConsole(o => o.LogToStandardErrorThreshold = LogLevel.Trace);

builder.Services
    .AddMcpServer()
    .WithStdioServerTransport()
    .WithToolsFromAssembly();

await builder.Build().RunAsync();
