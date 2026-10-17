# Screenshots and visual findings

Step `pipeline/visual.py` runs after the speed audit for every lead that has an email.

- Loads the homepage on a phone and a desktop (headless Chromium) and saves a first-screen screenshot of each.
- **Page findings** are measured, not guessed: phone number or call button visible on the first phone screen,
  page wider than the screen, city named in title/heading, local-business structured data, footer year,
  reviews mentioned, social links.
- **Vision findings**: Claude looks at the two screenshots and may add up to two observations in fixed categories
  (clarity, dated design, readability, trust, layout). Anything with numbers, links, wrong category or too long is dropped.
- Every finding carries a service (website, design, seo, social). The email writer builds Emails 1 and 2 around the
  single best finding and its service; Email 3 adds one soft line offering up to two other services.
- Screenshots and findings are uploaded to the dashboard. `GET /a/<token>` shows a private, noindex page with both
  screenshots, the findings and an "Other ways I can help" list. Email 1 links it. Opening it logs an `audit_viewed` touch.
  Security scanners sometimes prefetch links, so treat very early views with suspicion.
- Review page: the findings list shows the new findings and a "Private page" link so you can see what the lead will see.

Try it on any sites without touching leads: GitHub -> Actions -> **Visual preview** -> Run workflow, enter site URLs.
It prints the findings and publishes test pages (links in the log).

Cost: about 2-3 cents of Claude per lead (two images plus a short answer), no extra services.
