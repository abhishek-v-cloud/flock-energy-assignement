# Reflection

**A note on how I worked.** The brief allows AI assistants, and I used one (Claude) heavily, both to explore the portal and to write code. I want to be upfront about that. What I did myself was go back over the investigation step by step: I ran the portal calls by hand (login, search, transformers, geo, energy, the signing key and the signed export) until I could explain each one without notes. Everything in [PROTOCOL.md](PROTOCOL.md) is something I have checked against the live portal.

### What assumptions did you make?

- **Times are Indian Standard Time.** The portal gives timestamps like `23/06/2026 23:30` with no time zone. Everything else in the data (the place names, the coordinates) is in Jaipur, so I treat them as IST (+05:30).
- **`kwh` and `kvah` are running totals, not usage.** They work like a car's odometer: the number only goes up. So the energy used in an interval is the next reading minus the current one.
- **The transformer list is the "source of truth" for transformer names.** Three meters call DT-007 "Old Malviya Nagar Xfmr", but the transformer list and the other ten meters call it "Sanganer DT 7". I serve the official name and keep the old one in the meter's `dataQuality` list, so nothing is hidden.
- **A blank field is missing data, not a new node.** Each code always matches the same name (C-06 is always "Circle 6"), so a blank half can be filled in from the other meters.
- **The API is for internal use**, so I didn't add login to it, and the portal must only be read, never written to or overloaded.

### Which part was the most difficult, and how did you get unstuck?

**The signed export.** The "Export all meters" button on the Transformers page doesn't just call a URL. Its JavaScript first fetches a secret from `/portal/keys`, then builds an HMAC-SHA256 signature from the method, path, query and current time, and sends that in two headers. Calling the URL without them gives `401 signature_invalid`. What made it hard was that the first attempts were rejected even with a signature. The cause turned out to be Git Bash on Windows changing the `/portal/export` text into a Windows file path before it was signed. I learned to check that the *inputs* to an algorithm are what I think they are before deciding the algorithm is wrong. Once it worked, it was worth it: one call returns all 403 meters, instead of hundreds of separate calls.

**The hierarchy.** I expected a clean tree (zone → circle → … → transformer) with a few errors. When the meters were counted, every division, subdivision and substation turned up under several different parents, in roughly equal numbers. There was no "right" parent to pick. So instead of guessing, the API shows each meter's path exactly as the portal reports it, and says how many nodes at each level have more than one parent.

*[Add your own: which of these was hardest for you to understand when you walked through it yourself, and what made it click.]*

### If you had another day, what would you improve?

- Collect every meter's readings in the background (slowly, under the rate limit) and store them locally. Then the API could answer questions the portal can't, like "which meters use the most energy?" or "which decommissioned meters are still using power?".
- Add tests that run against the real portal once a night, so if the portal changes (for example the signature rules), we find out quickly.
- Reject unknown query parameters, so a typo like `?staus=faulty` returns an error instead of every meter.

### What mistake did you make while solving this?

- **Hitting the rate limit by accident.** Fetching consumption for all 403 meters at once (6 requests in parallel) got 397 of them rejected with `429 Too Many Requests`. That's how we discovered the portal allows only 120 requests per minute per login. The lesson: test a system's limits gently first, then speed up.
- **Assuming all meters were the same.** The first meter checked reports every 30 minutes, so I assumed they all did. Checking all of them showed only 40 do; the other 363 report once a day. If I had built around the first meter, the API would have been wrong for 90% of them.
- **Building too much at first.** The first version had extra endpoints, a web dashboard, charts and summary statistics. They worked, but they were more than the brief asked for, so I removed them to keep the project focused and easier to understand.

*[Add your own: a mistake you made while walking through the calls or setting up the project, e.g. a command that didn't work the first time and why.]*

### If you were reviewing your own submission, what would you criticise?

- **Everything depends on the signed export.** If the portal changes how signing works, the service keeps working on its saved copy for 24 hours, then stops. There is no backup way to load the meters.
- **The API docs are written by hand.** `openapi.json` and the code could drift apart over time. A test checks that every documented URL exists, but not every parameter.
- **It only works as one running copy.** The cache and the rate-limit counter live in memory. Two copies of the service would each log in and could together go over the portal's limit.
- **Heavy use of AI.** I used an assistant for much of the code. I've made sure I understand how it works and why it's built this way, but it isn't code I wrote line by line from scratch.
