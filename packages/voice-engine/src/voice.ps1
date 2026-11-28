# J.A.R.V.I.S. local voice engine (Windows; fully offline).
# Recognition: System.Speech (offline wake word + dictation).
# Speech:      modern WinRT natural voices (Windows.Media.SpeechSynthesis) with a crisp, professional
#              JARVIS-style delivery, falling back to System.Speech if WinRT voices are unavailable.
# Protocol: JSON lines. stdout events: ready, wake, command, speaking, spoken, stop, timeout, level, error.
# stdin commands: {"say":"text"} | {"stop":true} | {"mute":true|false} | {"voice":"name"} | {"quit":true}
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
[Console]::OutputEncoding = [Text.Encoding]::UTF8

function Emit($obj) { [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress)); [Console]::Out.Flush() }

# Voice name may be passed as the first argument to prefer a specific installed voice.
$preferredVoice = if ($args.Count -gt 0) { [string]$args[0] } else { '' }

# ----------------------------------------------------------------- recognition
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

# ----------------------------------------------------------------- speech (TTS)
# Preference order for a "professional JARVIS" voice: a refined British male, then any English male,
# then any English voice. WinRT exposes the modern, far more natural mobile/neural voices
# (e.g. "Microsoft Ryan", "Microsoft George", "Microsoft Guy"); System.Speech only has the older
# robotic desktop voices, so we use WinRT when we can and keep System.Speech purely as a fallback.
$script:ttsMode = 'sapi'          # 'winrt' | 'sapi'
$script:selectedVoiceName = ''
$winrtSynth = $null
$mediaPlayer = $null

# System.Speech is ALWAYS initialised as the guaranteed fallback; WinRT (nicer voices) is used when
# available and falls back to this per-utterance if anything goes wrong at runtime.
$sapi = New-Object System.Speech.Synthesis.SpeechSynthesizer
$sapi.SetOutputToDefaultAudioDevice()
$pick = $null
if ($preferredVoice) { $pick = $sapi.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Name -like "*$preferredVoice*" } | Select-Object -First 1 }
if (-not $pick) { $pick = $sapi.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -eq 'en-GB' -and $_.VoiceInfo.Gender -eq 'Male' } | Select-Object -First 1 }
if (-not $pick) { $pick = $sapi.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -like 'en*' -and $_.VoiceInfo.Gender -eq 'Male' } | Select-Object -First 1 }
if (-not $pick) { $pick = $sapi.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -eq 'en-GB' } | Select-Object -First 1 }
if ($pick) { $sapi.SelectVoice($pick.VoiceInfo.Name) }
$sapi.Rate = -1
$null = Register-ObjectEvent -InputObject $sapi -EventName SpeakCompleted -SourceIdentifier spoke
$script:selectedVoiceName = $sapi.Voice.Name

try {
  # Load the WinRT projection and pick the best natural voice.
  [void][Windows.Media.SpeechSynthesis.SpeechSynthesizer,Windows.Media,ContentType=WindowsRuntime]
  [void][Windows.Media.Playback.MediaPlayer,Windows.Media,ContentType=WindowsRuntime]
  [void][Windows.Media.Core.MediaSource,Windows.Media,ContentType=WindowsRuntime]

  $allVoices = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices
  function Pick-Winrt {
    param($predicate)
    foreach ($v in $allVoices) { if (& $predicate $v) { return $v } }
    return $null
  }
  $chosen = $null
  if ($preferredVoice) {
    $chosen = Pick-Winrt { param($v) $v.DisplayName -eq $preferredVoice -or $v.DisplayName -like "*$preferredVoice*" }
  }
  if (-not $chosen) { $chosen = Pick-Winrt { param($v) $v.Language -like 'en-GB*' -and $v.Gender -eq [Windows.Media.SpeechSynthesis.VoiceGender]::Male } }
  if (-not $chosen) { $chosen = Pick-Winrt { param($v) $v.Language -like 'en*' -and $v.Gender -eq [Windows.Media.SpeechSynthesis.VoiceGender]::Male } }
  if (-not $chosen) { $chosen = Pick-Winrt { param($v) $v.Language -like 'en-GB*' } }
  if (-not $chosen) { $chosen = Pick-Winrt { param($v) $v.Language -like 'en*' } }

  if ($chosen) {
    $winrtSynth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
    $winrtSynth.Voice = $chosen
    # A touch slower than default + full volume reads as calm and deliberate — the JARVIS cadence.
    try { $winrtSynth.Options.SpeakingRate = 0.92 } catch {}
    try { $winrtSynth.Options.AudioVolume = 1.0 } catch {}
    $mediaPlayer = New-Object Windows.Media.Playback.MediaPlayer
    $script:ttsMode = 'winrt'
    $script:selectedVoiceName = $chosen.DisplayName
  }
} catch { $script:ttsMode = 'sapi' }

function Speak-Sapi($text) {
  Emit @{ type = 'speaking' }
  $null = $sapi.SpeakAsync([string]$text)
}

function Speak-Text($text) {
  if ([string]::IsNullOrWhiteSpace($text)) { return }
  if ($script:ttsMode -eq 'winrt') {
    try {
      Emit @{ type = 'speaking' }
      # Drive the WinRT async op by polling its status — avoids the brittle AsTask/await plumbing in
      # Windows PowerShell 5.1. Synthesis is sub-second, so the short wait is imperceptible.
      $op = $winrtSynth.SynthesizeTextToStreamAsync($text)
      $spin = 0
      while ($op.Status -eq [Windows.Foundation.AsyncStatus]::Started -and $spin -lt 500) { Start-Sleep -Milliseconds 20; $spin++ }
      if ($op.Status -ne [Windows.Foundation.AsyncStatus]::Completed) { throw "synthesis status $($op.Status)" }
      $stream = $op.GetResults()
      $src = [Windows.Media.Core.MediaSource]::CreateFromStream($stream, $stream.ContentType)
      $mediaPlayer.Source = $src
      $mediaPlayer.Play()
      return
    } catch {
      # Any WinRT hiccup: fall back to the reliable System.Speech voice for this utterance.
      Emit @{ type = 'error'; message = "tts-winrt: $_" }
      try { Speak-Sapi $text } catch {}
      return
    }
  }
  Speak-Sapi $text
}

function Stop-Speaking {
  if ($mediaPlayer) { try { $mediaPlayer.Pause() } catch {} }
  try { $sapi.SpeakAsyncCancelAll() } catch {}
}

$state = @{ listeningForCommand = $false; muted = $false; wakeAt = [DateTime]::MinValue }

$null = Register-ObjectEvent -InputObject $rec -EventName SpeechRecognized -SourceIdentifier rec
$null = Register-ObjectEvent -InputObject $rec -EventName AudioLevelUpdated -SourceIdentifier lvl

$rec.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)
Emit @{ type = 'ready'; recognizer = $culture.Culture.Name; voice = $script:selectedVoiceName; engine = $script:ttsMode }

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
      if ($cmd.stop) { Stop-Speaking }
      if ($null -ne $cmd.mute) { $state.muted = [bool]$cmd.mute }
      if ($cmd.say) { Speak-Text ([string]$cmd.say) }
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
          Stop-Speaking; Emit @{ type = 'stop' }
        } elseif ($res.Grammar.Name -eq 'wake' -and $res.Confidence -gt 0.7 -and -not $state.listeningForCommand) {
          $state.listeningForCommand = $true; $state.wakeAt = Get-Date
          Stop-Speaking
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
if ($winrtSynth) { try { $mediaPlayer.Dispose(); $winrtSynth.Dispose() } catch {} }
if ($sapi) { try { $sapi.Dispose() } catch {} }
