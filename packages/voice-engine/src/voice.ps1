# J.A.R.V.I.S. local voice engine (Windows System.Speech; fully offline).
# Protocol: JSON lines. stdout events: ready, wake, command, speaking, spoken, error, level.
# stdin commands: {"say":"text"} | {"stop":true} | {"mute":true|false} | {"quit":true}
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
[Console]::OutputEncoding = [Text.Encoding]::UTF8

function Emit($obj) { [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress)); [Console]::Out.Flush() }

$culture = $null
foreach ($c in @('en-GB', 'en-US')) {
  $r = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | Where-Object { $_.Culture.Name -eq $c } | Select-Object -First 1
  if ($r) { $culture = $r; break }
}
if (-not $culture) { Emit @{ type = 'error'; message = 'No English speech recognizer is installed (Settings > Time & language > Speech).' }; exit 2 }

$rec = New-Object System.Speech.Recognition.SpeechRecognitionEngine($culture)
$rec.SetInputToDefaultAudioDevice()

$wake = New-Object System.Speech.Recognition.Choices
$wake.Add(@('hey jarvis', 'jarvis', 'ok jarvis'))
$wb = New-Object System.Speech.Recognition.GrammarBuilder
$wb.Culture = $culture.Culture
$wb.Append($wake)
$wakeGrammar = New-Object System.Speech.Recognition.Grammar($wb)
$wakeGrammar.Name = 'wake'

$stopChoices = New-Object System.Speech.Recognition.Choices
$stopChoices.Add(@('jarvis stop', 'stop talking', 'jarvis cancel', 'never mind'))
$sb = New-Object System.Speech.Recognition.GrammarBuilder
$sb.Culture = $culture.Culture
$sb.Append($stopChoices)
$stopGrammar = New-Object System.Speech.Recognition.Grammar($sb)
$stopGrammar.Name = 'stop'

$dictation = New-Object System.Speech.Recognition.DictationGrammar
$dictation.Name = 'dictation'
$dictation.Enabled = $false

$rec.LoadGrammar($wakeGrammar)
$rec.LoadGrammar($stopGrammar)
$rec.LoadGrammar($dictation)

$tts = New-Object System.Speech.Synthesis.SpeechSynthesizer
$tts.SetOutputToDefaultAudioDevice()
$voice = $tts.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -eq 'en-GB' } | Select-Object -First 1
if ($voice) { $tts.SelectVoice($voice.VoiceInfo.Name) }
$tts.Rate = 0

$state = @{ listeningForCommand = $false; muted = $false; wakeAt = [DateTime]::MinValue }

$null = Register-ObjectEvent -InputObject $rec -EventName SpeechRecognized -SourceIdentifier rec
$null = Register-ObjectEvent -InputObject $rec -EventName AudioLevelUpdated -SourceIdentifier lvl
$null = Register-ObjectEvent -InputObject $tts -EventName SpeakCompleted -SourceIdentifier spoke

$rec.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)
Emit @{ type = 'ready'; recognizer = $culture.Culture.Name; voice = $tts.Voice.Name }

$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [Text.Encoding]::UTF8)
$readTask = $stdin.ReadLineAsync()
$lastLevel = [DateTime]::MinValue

while ($true) {
  if ($readTask.IsCompleted) {
    $line = $readTask.Result
    if ($null -eq $line) { break }
    try {
      $cmd = $line | ConvertFrom-Json
      if ($cmd.quit) { break }
      if ($cmd.stop) { $tts.SpeakAsyncCancelAll() }
      if ($null -ne $cmd.mute) { $state.muted = [bool]$cmd.mute }
      if ($cmd.say) { Emit @{ type = 'speaking' }; $null = $tts.SpeakAsync([string]$cmd.say) }
    } catch { Emit @{ type = 'error'; message = "$_" } }
    $readTask = $stdin.ReadLineAsync()
  }

  Start-Sleep -Milliseconds 100
  $ev = Get-Event | Select-Object -First 1
  if ($ev) {
    Remove-Event -EventIdentifier $ev.EventIdentifier
    switch ($ev.SourceIdentifier) {
      'rec' {
        $res = $ev.SourceEventArgs.Result
        if ($state.muted) { break }
        if ($res.Grammar.Name -eq 'stop' -and $res.Confidence -gt 0.6) {
          $tts.SpeakAsyncCancelAll(); Emit @{ type = 'stop' }
        } elseif ($res.Grammar.Name -eq 'wake' -and $res.Confidence -gt 0.7 -and -not $state.listeningForCommand) {
          $state.listeningForCommand = $true; $state.wakeAt = Get-Date
          $tts.SpeakAsyncCancelAll()
          $dictation.Enabled = $true
          Emit @{ type = 'wake' }
        } elseif ($res.Grammar.Name -eq 'dictation' -and $state.listeningForCommand) {
          $dictation.Enabled = $false; $state.listeningForCommand = $false
          Emit @{ type = 'command'; text = $res.Text; confidence = $res.Confidence }
        }
      }
      'lvl' {
        if ($state.listeningForCommand -and ((Get-Date) - $lastLevel).TotalMilliseconds -gt 120) {
          $lastLevel = Get-Date; Emit @{ type = 'level'; value = $ev.SourceEventArgs.AudioLevel }
        }
      }
      'spoke' { Emit @{ type = 'spoken' } }
    }
  }
  if ($state.listeningForCommand -and ((Get-Date) - $state.wakeAt).TotalSeconds -gt 8) {
    $dictation.Enabled = $false; $state.listeningForCommand = $false; Emit @{ type = 'timeout' }
  }
}
$rec.RecognizeAsyncCancel()
$tts.Dispose()
