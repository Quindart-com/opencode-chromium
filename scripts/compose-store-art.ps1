# Composes Chrome Web Store listing art from captured popup renders.
#
# Layout: a branded header band (icon + product name + tagline) above a
# centered popup card. Text never overlaps the popup. Oversized popup captures
# are cropped into the card with a fade-out, so the composition stays clean at
# every canvas size.
#
# Usage:
#   powershell -File scripts/compose-store-art.ps1 -Popup <png> -Size 1280,800 -Out <png>
#   powershell -File scripts/compose-store-art.ps1 -Size 440,280 -Out <png> -Popup <png>
#   powershell -File scripts/compose-store-art.ps1 -Size 1400,560 -Out <png> -Popup <png> -BulletFile <txt>
#
# The bullet file contains one feature bullet per line (used by the marquee).
param(
  [Parameter(Mandatory = $true)][string]$Popup,
  [string]$Out,
  [string]$Size = "1280,800",
  [string]$Title = "opencode-chromium",
  [string]$Tagline = "Local browser automation for OpenCode, Codex, and MCP agents.",
  [string]$BulletFile = ""
)

Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = "Stop"

$root = Join-Path $PSScriptRoot ".."
$iconPath = Join-Path $root "store\icon-128.png"

$width, $height = ($Size -Split "," | ForEach-Object { [int]$_ })
$isMarquee = $width -ge 1000 -and (($height / $width) -lt 0.55)

$bgTop = [System.Drawing.ColorTranslator]::FromHtml("#182848")
$bgBottom = [System.Drawing.ColorTranslator]::FromHtml("#0a1220")
$titleColor = [System.Drawing.Color]::White
$taglineColor = [System.Drawing.ColorTranslator]::FromHtml("#c7d2e8")
$accentColor = [System.Drawing.ColorTranslator]::FromHtml("#7c9cff")
$bulletColor = [System.Drawing.ColorTranslator]::FromHtml("#dce4f5")
$cardBorderColor = [System.Drawing.Color]::FromArgb(140, 148, 163, 184)

function RoundedPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $path.AddArc($x, $y, $d, $d, 180, 90)
  $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  return $path
}

function DrawHeader([System.Drawing.Graphics]$g, [int]$canvasW, [int]$headerY, [int]$iconSize, [float]$titleSize, [float]$taglineSize, [bool]$centered) {
  $icon = [System.Drawing.Image]::FromFile($script:iconPath)
  $titleFont = New-Object System.Drawing.Font("Segoe UI", $titleSize, [System.Drawing.FontStyle]::Bold)
  $taglineFont = New-Object System.Drawing.Font("Segoe UI", $taglineSize, [System.Drawing.FontStyle]::Regular)
  $titleBrush = New-Object System.Drawing.SolidBrush $script:titleColor
  $taglineBrush = New-Object System.Drawing.SolidBrush $script:taglineColor

  $titleMeasure = $g.MeasureString($script:Title, $titleFont)
  $taglineMeasure = $g.MeasureString($script:Tagline, $taglineFont)
  $gap = 14
  $blockW = $iconSize + $gap + [Math]::Max($titleMeasure.Width, $taglineMeasure.Width)
  $blockH = [Math]::Max($iconSize, ($titleMeasure.Height + 4 + $taglineMeasure.Height))
  $blockX = if ($centered) { ($canvasW - $blockW) / 2 } else { 70 }
  $blockY = $headerY
  $iconY = $blockY + ($blockH - $iconSize) / 2

  if ($iconSize -gt 0) {
    $g.DrawImage($icon, [int]$blockX, [int]$iconY, $iconSize, $iconSize)
  }
  $textX = $blockX + $iconSize + $gap
  $textBlockH = $titleMeasure.Height + 4 + $taglineMeasure.Height
  $titleY = $blockY + (($blockH - $textBlockH) / 2)
  $g.DrawString($script:Title, $titleFont, $titleBrush, [float]$textX, [float]$titleY)
  $g.DrawString($script:Tagline, $taglineFont, $taglineBrush, [float]$textX, [float]($titleY + $titleMeasure.Height + 4))

  $icon.Dispose(); $titleFont.Dispose(); $taglineFont.Dispose(); $titleBrush.Dispose(); $taglineBrush.Dispose()
  return [int]($blockY + $blockH)
}

$bmp = New-Object System.Drawing.Bitmap($width, $height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

$rect = New-Object System.Drawing.Rectangle(0, 0, $width, $height)
$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $bgTop, $bgBottom, 90.0)
$g.FillRectangle($brush, $rect)
$brush.Dispose()

if ($width -lt 500) {
  # Small promo tile: stacked centered icon, title, tagline. No popup card.
  $icon = [System.Drawing.Image]::FromFile($iconPath)
  $iconSize = 64
  $iconX = [int](($width - $iconSize) / 2)
  $iconY = [int]($height * 0.14)
  $g.DrawImage($icon, $iconX, $iconY, $iconSize, $iconSize)
  $icon.Dispose()

  $titleFont = New-Object System.Drawing.Font("Segoe UI", 17, [System.Drawing.FontStyle]::Bold)
  $taglineFont = New-Object System.Drawing.Font("Segoe UI", 9.5, [System.Drawing.FontStyle]::Regular)
  $titleBrush = New-Object System.Drawing.SolidBrush $titleColor
  $taglineBrush = New-Object System.Drawing.SolidBrush $taglineColor
  $format = New-Object System.Drawing.StringFormat
  $format.Alignment = [System.Drawing.StringAlignment]::Center
  $titleMeasure = $g.MeasureString($Title, $titleFont)
  $titleH = [int]($titleMeasure.Height + 8)
  $titleRect = New-Object System.Drawing.RectangleF(10, ($iconY + $iconSize + 14), ($width - 20), $titleH)
  $taglineRect = New-Object System.Drawing.RectangleF(10, ($iconY + $iconSize + 14 + $titleH + 4), ($width - 20), 60)
  $g.DrawString($Title, $titleFont, $titleBrush, $titleRect, $format)
  $g.DrawString($Tagline, $taglineFont, $taglineBrush, $taglineRect, $format)
  $titleFont.Dispose(); $taglineFont.Dispose(); $titleBrush.Dispose(); $taglineBrush.Dispose(); $format.Dispose()
} else {
  $taglineSize = 13.0
  if ($isMarquee) { $taglineSize = 12.0 }
  $headerBottom = DrawHeader $g $width 40 56 21 $taglineSize (-not $isMarquee)

  $source = [System.Drawing.Image]::FromFile($Popup)
  $contentTop = $headerBottom + 26
  $contentBottom = $height - 44
  $maxCardH = $contentBottom - $contentTop

  if ($isMarquee) {
    # Marquee: feature bullets on the left, popup card on the right.
    $bulletSource = $Bullets
    if ($BulletFile -ne "" -and (Test-Path $BulletFile)) { $bulletSource = (Get-Content $BulletFile -Raw) }
    $bullets = @($bulletSource -Split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" })

    $bulletFont = New-Object System.Drawing.Font("Segoe UI", 13.5, [System.Drawing.FontStyle]::Regular)
    $bulletBrush = New-Object System.Drawing.SolidBrush $bulletColor
    $dotBrush = New-Object System.Drawing.SolidBrush $accentColor
    $textLeft = 70
    $textWidth = 560
    $textBlockH = $bullets.Count * 40
    $y = [float]($contentTop + [int](($maxCardH - $textBlockH) / 2) + 8)
    foreach ($bullet in $bullets) {
      $g.FillEllipse($dotBrush, $textLeft, $y + 7, 9, 9)
      $g.DrawString($bullet, $bulletFont, $bulletBrush, [float]($textLeft + 20), [float]$y)
      $y += 40
    }
    $bulletFont.Dispose(); $bulletBrush.Dispose(); $dotBrush.Dispose()

    $maxCardW = [Math]::Min(430, $width - ($textLeft + $textWidth) - 70)
    $scale = [Math]::Min(0.95, $maxCardW / $source.Width)
    $cardW = [int]($source.Width * $scale)
    $cardH = [Math]::Min($maxCardH, [int]($source.Height * $scale))
    $cardX = $width - $cardW - 70
    $cardY = $contentTop + [int](($maxCardH - $cardH) / 2)
    $crop = [Math]::Min($source.Height, [int]($cardH / $scale))
  } else {
    # Popup card: keep a readable 1:1 scale when the capture is popup-sized,
    # cropping the overflow into the card with a fade; otherwise fit.
    if ($source.Width -le ($width * 0.4)) {
      $scale = 1.0
      $cardW = $source.Width
      $cardH = [Math]::Min($source.Height, $maxCardH)
      $crop = $cardH
    } else {
      $scale = [Math]::Min((($width * 0.36) / $source.Width), ($maxCardH / $source.Height))
      if ($scale -gt 1.4) { $scale = 1.4 }
      $cardW = [int]($source.Width * $scale)
      $cardH = [int]($source.Height * $scale)
      if ($cardH -gt $maxCardH) { $cardH = $maxCardH }
      $crop = [Math]::Min($source.Height, [int]($cardH / $scale))
    }
    $cardX = [int](($width - $cardW) / 2)
    $cardY = $contentTop + [int](($maxCardH - $cardH) / 2)
  }

  # Soft glow behind the card
  $glowRect = [System.Drawing.Rectangle]::FromLTRB($cardX - 26, $cardY - 26, $cardX + $cardW + 26, $cardY + $cardH + 26)
  $glowPath = New-Object System.Drawing.Drawing2D.GraphicsPath
  $glowPath.AddEllipse($glowRect)
  $glow = New-Object System.Drawing.Drawing2D.PathGradientBrush $glowPath
  $glow.CenterColor = [System.Drawing.Color]::FromArgb(70, 92, 124, 255)
  $glow.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 10, 18, 32))
  $g.FillPath($glow, $glowPath)
  $glow.Dispose(); $glowPath.Dispose()

  # Card with shadow
  $cardPath = RoundedPath $cardX $cardY $cardW $cardH 18
  $shadowBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(120, 0, 0, 0))
  $g.TranslateTransform(0, 7)
  $g.FillPath($shadowBrush, $cardPath)
  $g.TranslateTransform(0, -7)
  $shadowBrush.Dispose()

  # Clipped popup image
  $g.SetClip($cardPath)
  $destRect = New-Object System.Drawing.RectangleF($cardX, $cardY, $cardW, ($crop * $scale))
  $srcRect = New-Object System.Drawing.RectangleF(0, 0, $source.Width, $crop)
  $g.DrawImage($source, $destRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)

  # Bottom fade inside the card when the popup is cropped
  if ($crop -lt $source.Height) {
    $fadeH = [Math]::Min([int]($cardH * 0.22), 130)
    $fadeRect = [System.Drawing.Rectangle]::Round((New-Object System.Drawing.RectangleF($cardX, ($cardY + $cardH - $fadeH), $cardW, $fadeH)))
    $fadeBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
      $fadeRect,
      [System.Drawing.Color]::FromArgb(0, 13, 21, 38),
      [System.Drawing.Color]::FromArgb(255, 13, 21, 38),
      90.0)
    $g.FillRectangle($fadeBrush, $fadeRect)
    $fadeBrush.Dispose()
  }
  $g.ResetClip()

  # Card border
  $pen = New-Object System.Drawing.Pen $cardBorderColor, 1.6
  $g.DrawPath($pen, $cardPath)
  $pen.Dispose(); $cardPath.Dispose(); $source.Dispose()
}

$outPath = if ($Out) { $Out } else { Join-Path $root ("store\composed-{0}x{1}.png" -f $width, $height) }
$dir = Split-Path -Parent $outPath
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output ("wrote {0} ({1} x {2})" -f $outPath, $width, $height)
