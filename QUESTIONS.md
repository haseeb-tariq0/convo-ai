# Open questions for Mohsin

From SPEC §17 + things that surfaced while scaffolding. None of these block the
demo dashboard; flag at the next sync.

## From SPEC §17 (defaults applied — confirm before real data)

1. **Real Nest sheet shape.** Columns, headers, timestamp format. Current
   seed assumes columns `Timestamp | Channel | UserId | Language | Message`
   and ISO-8601 timestamps. → Need a copy of the live "current process sheet"
   Mohsin offered to share.
2. **Chat language.** Seed mixes English + Arabic (Nest is GCC). Claude prompt
   currently assumes both languages — confirm.
3. **GA4 conversion event.** Default `purchase`; Rove uses something else?
4. **Sheet size.** Assumed ≤10k rows/sheet. If Nest is bigger, we need
   pagination on the Sheets fetch.
5. **Concurrent viewers per dashboard.** Assumed <10; if a client shares the
   link with a team of 50, we need a cache in front of `/data`.

## New (raised by scaffolding work, not in SPEC)

6. **Custom-metric definition flow.** SPEC §7 lets admin edit `field_config`
   as JSON, but the meeting transcript ("client asks for room service
   requests, I should be able to add it") implies a non-JSON editor. JSON
   editor lands first; visual builder is post-MVP. Confirm acceptable.
7. **Maps widget.** Shipped as a `map` field type using Google Maps' no-key
   embed iframe (`https://maps.google.com/maps?q=…&output=embed`). Configure
   per dashboard with `{type: "map", q: "<place query>", zoom?: <n>}`.
   Switch to the Maps JS API later if/when we want clustered chat-origin
   pins — needs a billable API key at that point.
8. **Share-link revoke UX.** SPEC has `/rotate-token`. Should the old link
   show a "this dashboard moved" message or a flat 404? Currently 404.
9. **Multi-dashboard per client.** SPEC §5 allows it (`dashboards.client_id`
   is many-to-one). Real-world: is "one client = one dashboard" always true,
   or do some clients want a per-property dashboard (Nest Dubai vs Nest Abu
   Dhabi)? Affects the admin UI's flow.
