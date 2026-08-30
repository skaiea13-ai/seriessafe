# SeriesSafe

**Move a recurring event to a different day — without losing the cancellations, make-ups, room changes and reminders you already set.**

Built for the [OpenAI WebMCP Challenge](https://webmcp.devpost.com/).

---

## The problem is real, and it is documented by the vendors themselves

Every calendar app offers "this and following" when you change a repeating event. What it actually does is end the old series and create a new one — and the customisations you made to future occurrences are discarded on the way.

This is not a bug report from us. It is how the platforms describe their own behaviour:

- **Google Calendar** implements a "this and following" change as two requests — truncate the old series, create a new one — and states that instances after the target are reset. <https://developers.google.com/workspace/calendar/api/guides/recurringevents>
- **Microsoft Exchange (MS-OXOCAL)** specifies that when a recurrence pattern changes, future exceptions are cancelled and the exception objects are removed. <https://learn.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-oxocal/4b92fb85-db55-4251-8e81-e319361218e1>
- **Microsoft's own guidance** warns organisations that ending a recurring series early loses the attached exceptions. <https://support.microsoft.com/en-us/outlook/best-practices-for-organizations-when-using-the-outlook-calendar>

So when a teacher moves a Tuesday class to Thursday from September, the two public holidays they cancelled quietly become classes again, the make-up session they had already moved to a Wednesday disappears, and the guest-lecture room booking goes with it. Nobody is told. There is no diff, and no undo that brings the exceptions back.

**SeriesSafe does the same edit without the loss, and proves it before committing anything.**

## What it does

Give it an `.ics` export and an ordinary sentence:

> "From September, move my Tuesday class to Thursday — but keep the holidays I cancelled, the make-up I already moved, and the guest-lecture room."

SeriesSafe:

1. reads the **series graph** behind the calendar grid — the rule, the cancellations (`EXDATE`), the detached overrides (`RECURRENCE-ID`), the added dates (`RDATE`) and the ordinal identity that links them;
2. re-anchors every future exception onto the new pattern;
3. shows you the same request applied **two ways** — as SeriesSafe applies it, and as a conventional edit applies it — with the losses itemised;
4. verifies eight invariants **against the serialized `.ics` bytes**, not against its own plan;
5. only then makes committing possible at all.

Everything runs in the tab. No calendar account, no upload, no server.

## The idea that makes it safe: week-anchored alignment

An exception moves to the slot holding the same place **in the same week**.

A cancellation on a Tuesday becomes a cancellation on that week's Thursday — because "that week is off" is indexed by week, not by calendar date.

A flat position would be simpler, and wrong. It agrees with week identity only while every week has the same number of slots on both sides, and it disagrees precisely in the boundary week, where the effective date can cut a different number of meetings from each rule. When a week cannot be matched one-to-one, the change is refused rather than guessed.

A detached override is re-anchored the same way, but **keeps its own start time**. A make-up already moved to Wednesday 16 September stays on Wednesday 16 September; only the slot it hangs from moves to Thursday 17 September. That single distinction is what stops it from being either absorbed into the new pattern or duplicated beside it.

An `RDATE` the rule does not already produce is not part of the pattern, so it is excluded from the count and keeps its own date. One that *does* coincide with a rule slot is simply that slot — treating it as an addition pulled a real occurrence out of the pattern.

## Why WebMCP, specifically

A calendar UI renders *occurrences*. The structure that defines them — which Tuesday is a cancellation rather than a gap, which event is a detached override rather than a separate meeting, which ordinal a given exception is anchored to — is never in the DOM. An agent working from pixels or from a month grid cannot recover it, and cannot tell a silently-lost exception from one that was never there.

WebMCP lets the page hand the agent the semantic layer it already owns, and keep the safety rules on the page side where they can be enforced:

| Tool | What it is for |
| --- | --- |
| `load_calendar` | Bring an `.ics` in (bundled sample, or pasted text). |
| `list_recurring_series` | Which series exist, and which carry exceptions. |
| `inspect_series` | The rule, zone, span, and how many occurrences are not ordinary. |
| `list_series_exceptions` | Every exception **with the ordinal that anchors it**. |
| `simulate_series_split` | Dry run. Returns the re-anchoring plan, the predicted losses, and any refusal. Changes nothing. |
| `stage_series_split` | Prepare the change. Refuses outright if anything cannot be re-anchored with certainty. |
| `validate_staged_split` | Eight invariants, each with concrete evidence, checked against the serialized file. |
| `compare_with_conventional_edit` | The same request applied both ways, itemised. |
| `export_calendar_ics` | The result, or deliberately the lossy version, for comparison. |
| `commit_staged_split` | **Registered only after validation passes.** |
| `undo_series_split` | **Registered only while a commit exists to revert.** |

Two properties are worth calling out:

**There is no `fix_my_calendar` tool.** The agent has to read the structure, propose a change, look at what the simulation says it would cost, and only then stage, validate and commit. It has to change course on intermediate results — an unsupported rule part, an override that cannot be re-anchored, an end date that would silently cost a meeting.

**Dynamic registration is the safety boundary, not a UI state.** `commit_staged_split` is not disabled before validation; it does not exist. Calling it returns *"No tool named commit_staged_split is registered right now."* This is covered by a test.

## Failing closed

Staging is refused, with a remedy, when SeriesSafe cannot prove the outcome:

| Refusal | Why |
| --- | --- |
| `UNSUPPORTED_RRULE_PART` | `BYSETPOS`, `BYWEEKNO`, `BYMONTH`… change how positions are counted. |
| `MULTIPLE_RRULE` | More than one `RRULE` on the master. |
| `RANGE_THISANDFUTURE` | An override that applies forward cannot be re-anchored safely. |
| `ORDINAL_OUT_OF_RANGE` | The new rule has no slot to carry a given exception. |
| `CADENCE_CHANGED` | The new rule meets a different number of times per period, so positions no longer line up with weeks. |
| `WEEK_NOT_ALIGNED` | A week holds a different number of meetings under each rule, so an exception in it has no matching slot. |
| `ORPHAN_OVERRIDE` | A customised occurrence is anchored to a date the rule never generates, so it has no position to carry. |
| `UNRESOLVED_TIME_ZONE` | The `TZID` is not one the browser can resolve, so every instant would be a guess. |
| `SERIES_TOO_LARGE` | The series exceeds the modelling limit, so it cannot be checked exhaustively. |
| `INVALID_TIME_OF_DAY` | The requested start time is not readable as `HH:MM`. |
| `END_DATE_DROPS_MEETINGS` | Holding the old end date would quietly cost a meeting. |
| `NOTHING_AFTER_DATE` / `NOTHING_BEFORE_DATE` | There is no split to make. |

### The end-of-series trap

Moving Tuesday → Thursday while keeping a fixed `UNTIL` date **silently drops the final meeting**, because the last Thursday falls before the last Tuesday. SeriesSafe surfaces the trade-off instead of choosing for you:

- `preserve-count` (default) — keep every remaining meeting; the end date shifts to Thu 31 Dec.
- `keep-end-date` — hold the original end date; **refused** here, because it would cost a class.

Our own validator caught this during development. It is now a regression test.

## The eight invariants

Checked after a round-trip through `.ics` text, so a bug in the writer cannot slip past:

1. Every occurrence before the effective date is unchanged — in timing **and** in content, down to each past override's own properties and alarms.
2. The original series produces nothing on or after the effective date.
3. Cancelled dates are still cancelled after the move.
4. Moved and customised occurrences survive, exactly once, at their own time.
5. Locations, attendees, reminders and private `X-` properties carried across.
6. No occurrence was duplicated.
7. The total number of real meetings is unchanged.
8. No other event in the calendar was modified.

## Verification

### Against real Chrome WebMCP

`npm run test:webmcp` launches Chrome with `--enable-features=WebMCPTesting` in a throwaway profile, opens the deployed page, and drives the tools **over the DevTools Protocol** — resolving each `RegisteredTool` from `getTools()` and calling `executeTool`, never by reaching into the app's own functions. It also clicks the in-page walkthrough and checks it completes.

Verified on **Chrome 151.0.7922.175** — 34/34 checks, against the live URL and localhost:

- the page binds to the browser's `ModelContext`, not the fallback harness;
- Chrome reports all nine tools over the CDP `WebMCP.toolsAdded` event;
- `commit_staged_split` is genuinely absent from `getTools()` before validation, appears after it passes, and `WebMCP.toolsRemoved` fires when it is withdrawn;
- the exported `.ics` keeps the make-up on its own Wednesday, re-anchored to the matching Thursday slot, along with the guest-lecture room, both cancellations, alarms and `X-` properties.

Two bugs were found this way and could not have been found any other way:

1. **The real `executeTool` signature is stricter than the draft docs.** It takes a `RegisteredTool` from `getTools()` plus the arguments as a JSON **string** — `executeTool(name, object)` throws *"The provided value is not of type 'RegisteredTool'"*. The scripted walkthrough was doing exactly that. The local harness now enforces Chrome's strictness so this cannot regress.
2. **Withdrawing a tool from inside its own execution aborts that execution.** `commit_staged_split` deregisters itself as its last act; up to Chrome 152, aborting the registration signal cancels the in-flight call, which then fails with *"The operation failed for an unknown transient reason"* despite having done the work. Withdrawal is now deferred by one task.

### Against the rendered pixels

`npm run test:a11y` and `npm run test:responsive` audit the running page in headless Chrome, in **both themes** and at 375 / 768 / 1024 / 1440.

The contrast audit composites translucent layers before measuring — a tag tinted 8% amber sitting on a row tinted 8% amber over a card over the page is flattened to the colour actually painted, and element opacity is folded into the text colour. Checking the declared token instead of the painted pixel is how contrast bugs survive review: an earlier version of this audit read `rgba(248,113,113,0.1)` as solid red and reported a 1.0:1 ratio on text that was fine.

Both themes currently report zero contrast failures, no touch target under 24px, no interactive element without a focus ring, no horizontal overflow, and no emoji standing in for an icon.

### Against an independent parser

The test suite checks SeriesSafe's output with **[ical.js](https://github.com/kewisch/ical.js) (Mozilla)** — an independent parser, not our own code — including exception relation and occurrence resolution.

Thirty-five tests cover the headline surgery, the conventional-edit control, every refusal path, the WebMCP tool layer end to end (including that `commit_staged_split` is unreachable before validation), and real-world shapes: all-day series, `COUNT`-based rules, fortnightly phase, series crossing a DST boundary, multiple series in one file, and malformed input.

```bash
npm install
npm test           # 35 unit and integration tests
npm run test:webmcp   # 34 checks against real Chrome WebMCP (macOS Chrome 149+)
npm run dev
```

The sample calendar mirrors a real Google Calendar export: folded lines, a `VTIMEZONE` block, a multi-value `EXDATE`, an `RDATE`, three detached overrides, alarms, and private `X-` properties. Any real `.ics` export works too.

## Running without WebMCP

If the browser has no `document.modelContext`, SeriesSafe registers the identical tool definitions against a local stand-in and says so in the header. The **"Watch an agent do it"** button then drives the full eight-call sequence through `getTools()` and `executeTool`, exactly as an external agent would. Nothing is faked — only the transport differs.

The stand-in mirrors Chrome 151's behaviour *including its strictness*: `registerTool` resolves with `undefined`, `getTools` returns `inputSchema` as a JSON string, and `executeTool` requires a `RegisteredTool` plus a JSON string and rejects anything else. A permissive stand-in hid a real bug once; it will not again.

To enable the browser API yourself: Chrome 149 or later, `chrome://flags/#enable-webmcp-testing` → **Enabled**, then relaunch.

## Scope

The operating surface is deliberately narrow, and everything outside it is refused rather than approximated.

**Operated on:** `FREQ=WEEKLY` with `INTERVAL`, `BYDAY`, `COUNT`, `UNTIL` and `WKST`; UTC, floating and `TZID` times with DST-correct wall-clock arithmetic including gap and fold; all-day (`VALUE=DATE`) series; `EXDATE`, `RDATE`, detached `RECURRENCE-ID`, `STATUS:CANCELLED` overrides, `VALARM`, `ATTENDEE` with its parameters, `X-` properties, and lossless retention of every property SeriesSafe does not itself understand.

**Refused:** `RANGE=THISANDFUTURE`; multiple `RRULE`s; positional parts (`BYSETPOS`, `BYWEEKNO`, `BYYEARDAY`, `BYMONTH`, `BYHOUR`…); and any rule part this engine does not expand *exactly* — notably `BYDAY` on a non-weekly frequency. `FREQ=MONTHLY;BYDAY=1MO` means the first Monday of the month, and an engine that renders it as the first of the month is not entitled to edit it, so it says so instead.

Live OAuth write-back to Google or Microsoft is out of scope; SeriesSafe works on `.ics` import and export, which is the interchange format both providers document.

## Licence

MIT — see [LICENSE](LICENSE).
