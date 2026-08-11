# Fingerprints the SEO-bearing parts of every built page, so a content edit can
# be proven not to have touched them.
#
#   .\web\seo-fingerprint.ps1 -Save     write baseline  (run BEFORE editing)
#   .\web\seo-fingerprint.ps1           compare vs baseline (run AFTER editing)
#
# Run `npm --prefix web run build` before each invocation — this reads web\dist,
# not the source. See docs/WEBSITE-STRUCTURE.md §14.
param(
  [switch]$Save,
  [string]$Root     = 'web\dist',
  [string]$Baseline = 'web\seo-baseline.json'
)

function Get-SeoFingerprint {
  param([string]$Root)
  # Use .FullName, not $env:TEMP-style paths — 8.3 short names ("CHRIST~1") will
  # not string-match the long form returned by DirectoryName, which silently
  # leaves the absolute path in `url` and reports every page as changed.
  $base = (Get-Item $Root).FullName
  Get-ChildItem -Recurse -Filter index.html $Root | ForEach-Object {
    $c = Get-Content $_.FullName -Raw
    [pscustomobject]@{
      url       = '/' + $_.DirectoryName.Substring($base.Length).TrimStart('\').Replace('\','/')
      # $(if ...) subexpressions are required — PowerShell 5.1 rejects a bare
      # `if` as a hashtable value ("The hash literal was incomplete").
      title     = $(if ($c -match '(?s)<title>(.*?)</title>') { $matches[1] } else { '' })
      desc      = $(if ($c -match '<meta name="description" content="([^"]*)"') { $matches[1] } else { '' })
      canonical = $(if ($c -match '<link rel="canonical" href="([^"]*)"') { $matches[1] } else { '' })
      robots    = $(if ($c -match '<meta name="robots" content="([^"]*)"') { $matches[1] } else { '' })
      h1        = ([regex]::Matches($c,'<h1[^>]*>')).Count
      jsonld    = (([regex]::Matches($c,'(?s)<script type="application/ld\+json">(.*?)</script>') |
                    ForEach-Object { $_.Groups[1].Value }) -join '~')
    }
  } | Sort-Object url
}

$FIELDS = 'url','title','desc','canonical','robots','h1','jsonld'

if (-not (Test-Path $Root)) { throw "No build at $Root. Run: npm --prefix web run build" }
$current = Get-SeoFingerprint -Root $Root

if ($Save) {
  $current | ConvertTo-Json -Depth 3 -Compress | Out-File $Baseline -Encoding utf8
  "Baseline saved: $($current.Count) pages -> $Baseline"
  return
}

if (-not (Test-Path $Baseline)) { throw "No baseline at $Baseline. Run with -Save first." }
$diff = Compare-Object (Get-Content $Baseline -Raw | ConvertFrom-Json) $current -Property $FIELDS

if ($diff) {
  "SEO CHANGED - $($diff.Count) row(s):"
  $diff | Select-Object SideIndicator,url,title,desc,canonical,robots,h1 | Format-Table -AutoSize -Wrap
  "(<= baseline, => current)"
  exit 1
} else {
  "PASS - SEO surface unchanged across all $($current.Count) pages."
}
