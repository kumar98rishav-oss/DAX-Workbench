using System.Net.Http.Json;
using System.Text.Json.Serialization;

namespace PbiDesktopBridge;

/// <summary>
/// Version + update discovery.
///
/// The product ships as ONE portable exe, so "updating" is replacing a single
/// file — there is no installer state to reconcile. This deliberately does NOT
/// download or self-replace: it only tells the user a newer release exists and
/// opens the page. Silent self-update of an unsigned binary is exactly the
/// behaviour a security-minded user should distrust, and the whole product is
/// built on "your machine, your call".
///
/// The check is USER-INITIATED from the tray. Nothing phones home on a timer.
/// </summary>
public static class Updates
{
    /// <summary>The one place the version is declared. Keep in step with
    /// package.json and the git tag when releasing.</summary>
    public const string Version = "0.4.1";

    public const string ReleasesUrl = "https://github.com/kumar98rishav-oss/DAX-Workbench/releases/latest";
    private const string ApiUrl = "https://api.github.com/repos/kumar98rishav-oss/DAX-Workbench/releases/latest";

    private sealed class ReleaseInfo
    {
        [JsonPropertyName("tag_name")] public string? TagName { get; set; }
        [JsonPropertyName("html_url")] public string? HtmlUrl { get; set; }
    }

    public sealed record Result(bool Available, string Latest, string Current, string Url, string? Error);

    /// <summary>Ask GitHub for the latest release tag. Never throws.</summary>
    public static async Task<Result> CheckAsync(CancellationToken ct = default)
    {
        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
            // GitHub's API rejects requests without a User-Agent.
            http.DefaultRequestHeaders.UserAgent.ParseAdd($"DAX-Workbench/{Version}");

            var res = await http.GetAsync(ApiUrl, ct);
            // A repo with no published releases answers 404 — that is "nothing to
            // update to", NOT a connection problem. Reporting it as an error
            // would tell the user their network is broken when it isn't.
            if (res.StatusCode == System.Net.HttpStatusCode.NotFound)
                return new Result(false, "", Version, ReleasesUrl, null);
            res.EnsureSuccessStatusCode();

            var rel = await res.Content.ReadFromJsonAsync<ReleaseInfo>(cancellationToken: ct);
            var tag = rel?.TagName?.TrimStart('v', 'V') ?? "";
            if (tag.Length == 0) return new Result(false, "", Version, ReleasesUrl, null);
            return new Result(IsNewer(tag, Version), tag, Version, rel?.HtmlUrl ?? ReleasesUrl, null);
        }
        catch (Exception e)
        {
            // Offline is the normal case for a local-first tool, not an error
            // worth alarming anyone about.
            return new Result(false, "", Version, ReleasesUrl, e.Message);
        }
    }

    /// <summary>Compare dotted numeric versions. Non-numeric or ragged parts
    /// compare as 0, so "0.4" and "0.4.0" are equal rather than surprising.</summary>
    public static bool IsNewer(string candidate, string current)
    {
        var a = Parts(candidate);
        var b = Parts(current);
        for (var i = 0; i < Math.Max(a.Length, b.Length); i++)
        {
            var x = i < a.Length ? a[i] : 0;
            var y = i < b.Length ? b[i] : 0;
            if (x != y) return x > y;
        }
        return false;
    }

    private static int[] Parts(string v) =>
        v.Split('.', '-', '+')
         .Select(p => int.TryParse(p, out var n) ? n : 0)
         .ToArray();
}
