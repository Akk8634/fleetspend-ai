param([string]$Dir = $PSScriptRoot, [string]$Voice = 'Microsoft Zira Desktop', [int]$Rate = 1)
# Generates one WAV per narration segment using the built-in Windows speech engine.
Add-Type -AssemblyName System.Speech
$items = Get-Content -Raw -Encoding UTF8 (Join-Path $Dir 'narration.json') | ConvertFrom-Json
$out = Join-Path $Dir 'audio'
New-Item -ItemType Directory -Force $out | Out-Null
foreach ($it in $items) {
  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $s.SelectVoice($Voice)
  $s.Rate = $Rate
  $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(24000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
  $path = Join-Path $out ($it.id + '.wav')
  $s.SetOutputToWaveFile($path, $fmt)
  $s.Speak($it.text)
  $s.Dispose()
  Write-Output ("{0} {1}" -f $it.id, (Get-Item $path).Length)
}
