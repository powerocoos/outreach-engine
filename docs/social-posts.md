# Social posts from the blog

New Squarespace blog posts -> Claude drafts a Facebook post and an Instagram caption -> you review at
`<dashboard>/social` -> publish (or copy into Meta Business Suite).

## How it runs
- GitHub Action `Social drafts` (daily 6:30 AM Eastern, or run it by hand) runs `pipeline/social.py`.
- It reads the blog feed (`/updates?format=rss`), skips posts the dashboard already has, and only looks at posts
  from the last 21 days (`SOCIAL_MAX_AGE_DAYS`). At most 3 per run (`SOCIAL_MAX_PER_RUN`).
- Every draft is checked: no URLs or phone numbers in the text, hashtag count, word counts, and every number
  must appear in the blog post. If Claude fails twice it falls back to a plain template (still reviewed by you).
- Facebook links carry `utm_source=facebook&utm_medium=social&utm_campaign=blog-share`, so the GA4 panel shows
  how much traffic each post sends. Instagram captions say "Link in bio".
- Nothing posts until you approve it on the Social posts page.

## Without Meta connected (works today)
Approve a post, press **Copy Facebook text** / **Copy Instagram caption**, paste into Meta Business Suite,
then press **Mark as posted**.

## Connecting Facebook + Instagram (one-time, optional)
Needs an Instagram professional (business or creator) account linked to the Facebook Page. Meta changes these
screens often, so treat the steps as a guide.
1. developers.facebook.com -> create an app (type Business). Stay in Development mode: it can post to pages
   you own without app review.
2. In Graph API Explorer pick that app, request `pages_show_list`, `pages_read_engagement`,
   `pages_manage_posts`, `instagram_basic`, `instagram_content_publish`, and generate a user token.
3. Exchange it for a long-lived user token, then `GET /me/accounts` returns the Page id and a Page token
   (a Page token made from a long-lived user token does not expire).
4. `GET /<page-id>?fields=instagram_business_account` returns the Instagram user id.
5. Add Worker secrets: `META_PAGE_ID`, `META_PAGE_TOKEN`, `META_IG_USER_ID` (IG is optional).
   If Meta retires the API version, set the variable `META_GRAPH_VERSION` (default v23.0).
Publish buttons then appear on the Social posts page. Instagram only accepts JPEG images; posts whose header
image is a PNG are Facebook-only.

## Later: Google Business Profile
The same drafts table can feed a third channel once Google approves Business Profile API access.

## Instagram images

Instagram only accepts a public https JPEG. When a blog post's featured image is not a JPEG (or is missing), the
drafting job renders a branded 1080x1080 "NEW ON THE BLOG" card (`pipeline/social_image.py`, Poppins fonts in
`pipeline/fonts/`), uploads it to the dashboard (`PUT /api/social-image/<id>`) and stores its public link
(`/img/social/<id>.jpg`) as the post image. Facebook is unaffected: it posts the blog link and Facebook builds the
preview from the blog page. Posts drafted before this change keep their original image; edit or re-queue them if
Instagram is blocked.

## Scheduling

Approving a post books the next free **9:00 AM Eastern** slot (one post per day). Change the time, or choose
"Do not auto-post", on the approved card. A Worker cron (every 30 minutes) publishes posts whose time has arrived,
to every connected channel that can take the post. Each channel posts at most once; a failing post is retried up to
3 times, then stops and shows its error on the card. "Publish" buttons still post immediately. Times are entered and
shown in Eastern Time; stored as UTC.
