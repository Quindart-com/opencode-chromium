# Composes a Chrome Web Store listing screenshot (1280x800) from a captured
# popup render, plus an optional 440x280 promo tile.
#
# Usage: powershell -File scripts/compose-store-art.ps1 -Popup <png> [-Size 1280,800|440,280] -Out <png>
param(
  [Parameter(Mandatory = $true)][string]$Popup,
  [string]$Out,
  [string]$Size = "1280,800"
)

Add-Type -AssemblyName System.Drawing

$width, $height = ($Size -Split "," | ForEach-Object { [int]$_ })
$scale = if ($width -ge 1000) { 1.65 } else { 0.85 }
$label = if ($width -ge 1000) { "Downloads as a local-native browser bridge for OpenCode, Codex, and MCP agents." } else { "" }

$source = [System.Drawing.Image]::FromFile($Popup)
$popupWidth = [int]($source.Width * $scale)
$popupHeight = [int]($source.Height * $scale)

$bmp = New-Object System.Drawing.Bitmap($width, $height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

# Background gradient
$rect = New-Object System.Drawing.Rectangle(0, 0, $width, $height)
$top = [System.Drawing.ColorTranslator]::FromHtml("#16233f")
$bottom = [System.Drawing.ColorTranslator]::FromHtml("#0a1220")
$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $top, $bottom, 90.0)
$g.FillRectangle($brush, $rect)
$brush.Dispose()

# Soft glow behind the popup
$glowRect = New-Object System.Drawing.Rectangle(
  [int](($width - $popupWidth * 1.12) / 2),
  [int](($height - $popupHeight * 1.12) / 2),
  [int]($popupWidth * 1.12),
  [int]($popupHeight * 1.12)
)
$glow = New-Object System.Drawing.Drawing2D.PathGradientBrush ([System.Drawing.Drawing2D.GraphicsPath]::new())
$path = [System.Drawing.Drawing2D.GraphicsPath]::new()
$path.AddEllipse($glowRect)
$glow = New-Object System.Drawing.Drawing2D.PathGradientBrush($path)
$glow.CenterColor = [System.Drawing.Color]::FromArgb(90, 79, 124, 255)
$glow.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 10, 18, 32))
$g.FillEllipse($glow, $glowRect)
$glow.Dispose()
$path.Dispose()

# Popup card with border + shadow
$cardRect = New-Object System.Drawing.Rectangle(
  [int](($width - $popupWidth) / 2),
  [int](($height - $popupHeight) / 2) - 12,
  $popupWidth,
  $popupHeight
)
$shadow = New-Object System.Drawing.Drawing2D.GraphicsPath
$shadow.AddRectangle($cardRect)
$shadowBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(140, 0, 0, 0))
$g.TranslateTransform(0, 6)
$g.FillPath($shadowBrush, $shadow)
$g.TranslateTransform(0, -6)
$g.DrawImage($source, $cardRect)
$pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(120, 148, 163, 184)), 1.5
$g.DrawRectangle($pen, $cardRect)

# Caption
if ($label -ne "") {
  $font = New-Object System.Drawing.Font("Segoe UI", 17, [System.Drawing.FontStyle]::Regular)
  $textBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml("#c7d2e8"))
  $format = New-Object System.Drawing.StringFormat
  $format.Alignment = [System.Drawing.StringAlignment]::Center
  $format.LineAlignment = [System.Drawing.StringAlignment]::Far
  $textRect = New-Object System.Drawing.RectangleF(60, $height - 92, $width - 120, 40)
  $g.DrawString($label, $font, $textBrush, $textRect, $format)
  $textBrush.Dispose()
  $font.Dispose()
}

$outPath = if ($Out) { $Out } else { Join-Path $PSScriptRoot "..\store\$Size-listing.png" }
$dir = Split-Path -Parent $outPath
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
$source.Dispose()
Write-Output "wrote $outPath ($width x $height)"