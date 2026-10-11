# Clear to Air - run the Windows built-in OCR engine (Windows.Media.Ocr) on one or more images.
#
# Called by agent/src/stats/ocr.js (async spawn, with a timeout):
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ocr-windows.ps1 -Path "<a.png>|<b.png>" [-Lang en-US]
# Several images ('|'-separated - '|' cannot appear in a Windows path) share one
# PowerShell start-up and one engine, which is most of the cost.
# Prints ONE line of JSON on stdout and always exits 0:
#   {"ok":true,"lang":"en-US","results":[{"ok":true,"w":1920,"h":1080,"lines":[{"text":"..","words":[{"text":"..","x":0,"y":0,"w":0,"h":0}]}]}, ...]}
#   {"ok":false,"reason":"..."}
#   -ListLanguages -> {"ok":true,"languages":["en-US",...],"maxImageDimension":10000}
#
# Image preparation (finding the table cells, scaling, dark-on-white) is done
# in ocr.js; this script only reads the pixels it is given. Windows PowerShell
# 5.1 cannot `await` a WinRT IAsyncOperation, so every async call goes through
# WindowsRuntimeSystemExtensions.AsTask<T>, found by reflection.
# Nothing here touches the network or writes a file.

param(
  [string]$Path = '',
  [string]$Lang = '',
  [switch]$ListLanguages
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

function Out-Json($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Depth 7 -Compress))
}

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
  $null = [Windows.Storage.FileAccessMode, Windows.Storage, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics, ContentType = WindowsRuntime]
  $null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
} catch {
  Out-Json @{ ok = $false; reason = "WinRT is not available in this PowerShell: $($_.Exception.Message)" }
  exit 0
}

$script:AsTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1

function Await($op, [Type]$resultType) {
  $task = $script:AsTask.MakeGenericMethod($resultType).Invoke($null, @($op))
  $null = $task.Wait(-1)
  return $task.Result
}

function Read-Image($engine, [string]$one) {
  if (-not (Test-Path -LiteralPath $one)) { return [ordered]@{ ok = $false; reason = "image not found: $one" } }
  $full = (Resolve-Path -LiteralPath $one).ProviderPath
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($full)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  try {
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $max = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
    if ($decoder.PixelWidth -gt $max -or $decoder.PixelHeight -gt $max) {
      return [ordered]@{ ok = $false; reason = "image is larger than the OCR engine's $max px limit" }
    }
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync(
        [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
        [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied)) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    $w = [int]$decoder.PixelWidth
    $h = [int]$decoder.PixelHeight
  } finally {
    $stream.Dispose()
  }
  $lines = New-Object System.Collections.ArrayList
  foreach ($line in $result.Lines) {
    $words = New-Object System.Collections.ArrayList
    foreach ($word in $line.Words) {
      $r = $word.BoundingRect
      $null = $words.Add([ordered]@{ text = $word.Text; x = [Math]::Round($r.X, 1); y = [Math]::Round($r.Y, 1); w = [Math]::Round($r.Width, 1); h = [Math]::Round($r.Height, 1) })
    }
    $null = $lines.Add([ordered]@{ text = $line.Text; words = $words })
  }
  return [ordered]@{ ok = $true; w = $w; h = $h; lines = $lines }
}

try {
  if ($ListLanguages) {
    $langs = New-Object System.Collections.ArrayList
    foreach ($l in [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages) { $null = $langs.Add($l.LanguageTag) }
    Out-Json @{ ok = $true; languages = $langs; maxImageDimension = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension }
    exit 0
  }

  $paths = @($Path -split '\|' | Where-Object { $_ })
  if (-not $paths.Count) {
    Out-Json @{ ok = $false; reason = 'no image given (-Path)' }
    exit 0
  }

  # Engine: the asked-for language if installed, else English, else the user profile languages.
  # Scoreboards are digits and Latin IGNs, so English is the right default.
  $engine = $null
  $want = @()
  if ($Lang) { $want += $Lang }
  $want += 'en-US', 'en-GB'
  foreach ($tag in $want) {
    $lg = New-Object Windows.Globalization.Language($tag)
    if ([Windows.Media.Ocr.OcrEngine]::IsLanguageSupported($lg)) {
      $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lg)
      if ($engine) { break }
    }
  }
  if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
  if (-not $engine) {
    Out-Json @{ ok = $false; reason = 'no Windows OCR language is installed (Settings > Time & language > Language & region > add English)' }
    exit 0
  }

  $results = New-Object System.Collections.ArrayList
  foreach ($one in $paths) {
    try { $null = $results.Add((Read-Image $engine $one)) }
    catch { $null = $results.Add([ordered]@{ ok = $false; reason = "OCR failed: $($_.Exception.Message)" }) }
  }
  Out-Json ([ordered]@{ ok = $true; lang = $engine.RecognizerLanguage.LanguageTag; results = $results })
  exit 0
} catch {
  Out-Json @{ ok = $false; reason = "OCR failed: $($_.Exception.Message)" }
  exit 0
}
