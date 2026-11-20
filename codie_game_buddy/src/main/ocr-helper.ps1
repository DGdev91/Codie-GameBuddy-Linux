# OCR helper for ocr.mjs, run by Windows PowerShell 5.1 (PowerShell 7 cannot
# load WinRT types). Reads "<id> <language tag> <base64 image>" lines on stdin
# and writes one JSON line per request: {"id":1,"lines":[...]} or
# {"id":1,"error":"..."}. Exits when stdin closes.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]

$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1
function Await($op, [type]$type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  $task.Result
}

$engines = @{}
function EngineFor([string]$tag) {
  if (-not $engines.ContainsKey($tag)) {
    $engines[$tag] = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new($tag))
  }
  $engines[$tag]
}

while ($null -ne ($line = [Console]::In.ReadLine())) {
  $id, $tag, $data = $line.Split(' ', 3)
  try {
    $engine = EngineFor $tag
    if (-not $engine) { throw "no OCR language $tag" }
    $bytes = [Convert]::FromBase64String($data)
    $stream = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream([IO.MemoryStream]::new($bytes))
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    $reply = @{ id = [int]$id; lines = @(foreach ($l in $result.Lines) { $l.Text }) }
  } catch {
    $reply = @{ id = [int]$id; error = $_.Exception.Message }
  }
  [Console]::Out.WriteLine((ConvertTo-Json $reply -Compress))
  [Console]::Out.Flush()
}
