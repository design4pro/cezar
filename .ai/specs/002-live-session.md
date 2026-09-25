# 002 — Żywa sesja: follow-upy i obrazki w trakcie taska

Status: ZAIMPLEMENTOWANE 2026-07-10 · Fala: 1 · Zależy od: — · Wzorzec: janitor `claudeRunner.ts` (proces bez `-p`, stdin NDJSON)

## Cel

Task przestaje być "odpal i patrz". W trakcie działania agenta user może
dopisać wiadomość, odpowiedzieć na pytanie i wkleić screenshot — a po
skończonej turze sesja chwilę czeka, zamiast umierać.

## UX (jak cep)

- Na dole widoku taska jest **jedno pole tekstowe + Enter**. Zawsze to samo,
  niezależnie czy task biegnie, czy agent czeka. Zero trybów.
- Screenshot: **Cmd+V w pole tekstowe** (miniaturka pojawia się nad polem)
  albo spinacz. Nic więcej.
- Gdy agent skończy turę i czeka: badge zmienia się na **`waiting`**
  (kolor żółty, task skacze na górę listy). Wpisanie wiadomości → znowu
  `running`. Przycisk **„Zakończ"** zamyka sesję (task → `done`).
- Skróty jak w janitorze: `Alt+A` = "Yes, approved.", `Alt+C` = "Continue."

## Zakres

1. **Runner: proces wieloturowy.** `ClaudeCliRunner` przestaje zamykać stdin po
   pierwszej wiadomości. Nowe API:
   - `sendMessage(content: ContentBlock[])` — pisze linię
     `{type:"user", message:{role:"user",content}, session_id}` na stdin.
   - `endSession()` — zamyka stdin; watchdog EOF→SIGTERM (8 s)→SIGKILL (4 s)
     (claude w stream-json potrafi zignorować EOF — potwierdzone w janitorze).
   - Zdarzenie `turn-end` emitowane na `type:"result"` (obok istniejących).
2. **Semantyka kroków:**
   - Krok agentowy w **chainie wielokrokowym**: po `turn-end` runner robi
     `endSession()` i silnik idzie dalej (jak dziś). Bez zmian w YAML.
   - **Ostatni krok agentowy** (i cały `quick-task`): po `turn-end` sesja
     zostaje otwarta, task → status **`waiting`**; wiadomość usera → `running`;
     „Zakończ" albo idle-timeout **15 min** → `endSession()` → `done`.
   - Okno reopen: follow-up wysłany między `result` a zamknięciem (250 ms)
     wraca do tej samej tury — kasujemy timer zamknięcia (wzorzec janitora).
3. **Statusy:** nowy `waiting` w `RunStatus`/`StepStatus` (GUI: żółty, sort na
   górę listy). Janitor ma `needs_input` tylko w typach — my robimy naprawdę.
4. **Obrazy:** GUI robi base64 (`File.arrayBuffer()`/`clipboardData.items`);
   serwer buduje bloki `{type:"image", source:{type:"base64", media_type,
   data}}`; limit 5 MB/obraz, 4 obrazy/wiadomość.
5. **API:** `POST /api/runs/:id/messages` `{text, images?:[{mediaType,data}]}` →
   404 gdy brak taska, 409 gdy sesja zamknięta (GUI wtedy pokazuje przycisk
   „Kontynuuj" — spec 003). `POST /api/runs/:id/finish` = „Zakończ".
6. **Persist:** wiadomość usera zapisywana jako event `user-message` do NDJSON
   (widoczna w transkrypcie i po odświeżeniu).

## Poza zakresem

- Streaming częściowych tokenów (`--include-partial-messages`) — janitor to
  świadomie wyłączył, my też: eventy per blok wystarczą.
- Głos, pliki inne niż obrazy.

## Projekt techniczny

- `src/core/claude-cli-runner.ts`: refaktor `runOnce` → obiekt `Session`
  (`start(spec)`, `sendMessage`, `endSession`, `onEvent`); mapa
  `runId → Session` w `RunManager`. Timeout całościowy zostaje jako bezpiecznik
  (podbity do 60 min dla sesji interaktywnych).
- `src/workflows/run.ts`: `RunManager.sendMessage(runId, content)` +
  `finish(runId)`; logika `waiting` po ostatnim kroku; idle-timer.
- `src/runs/store.ts`: status `waiting`; event `user-message`.
- `web/app.js`: pasek wiadomości (textarea + paste handler + spinacz +
  miniaturki), badge `waiting`, skróty Alt+A/C.
- Mock: `scripts/mock-claude.mjs` rozszerzony o pętlę czytania stdin
  (odpowiada na follow-upy) — testy bez tokenów.

## Kroki implementacji

1. Refaktor runnera na `Session` + watchdog EOF (testy z mockiem).
2. Statusy `waiting` + przepływ w `RunManager` + idle-timer.
3. Endpointy messages/finish + event `user-message`.
4. GUI: pasek wiadomości + obrazy + badge.
5. Test ręczny na żywym `claude`: zadaj pytanie w prompcie („zapytaj mnie
   zanim coś zmienisz"), odpowiedz, wklej obrazek.

## Kryteria akceptacji

- W trakcie tury wysłana wiadomość dociera do agenta (widać reakcję w logu).
- Po turze task jest `waiting`; wiadomość wznawia; „Zakończ" kończy; po 15 min
  bezczynności kończy się sam.
- Wklejony screenshot jest opisywalny przez agenta („co widzisz na obrazku?").
- Po restarcie serwera taski `waiting` są odzyskiwane jako `failed —
  interrupted` (jak dziś running) — bez zombie.

## Amendment 2026-09-25: in-flight turn watchdog

The idle timeout bounds a PARKED session only. The turn of the last agent step runs with
`timeoutMs: 0`, so a turn that hung (the CLI, or a tool call it was blocked on) had no bound and
held its slot until cezar restarted: 8527e447 (2026-09-24) sat 46 minutes after `step-start`
without one event.

`RunManager` now arms `TURN_INACTIVITY_TIMEOUT_MS` (30 min) whenever a turn starts: a session
opening, or a message sent into it (a user message, a monitoring wake, an inbox digest, the
autonomous nudge). Every runner event (`onEvent` or `onUiEvent`) pushes it out; `turn-end`, an
error and a native ask clear it, so `waiting` and `monitoring` parks keep their own bounds. When it
fires, the step's own error path runs with "No agent activity for 30m during a turn…": the session
is interrupted and the run settles `failed` with its Continue button. The longest legitimate
silence in the run history is ~15 minutes (a validation gate inside one tool call).
