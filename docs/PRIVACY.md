# ModPilot — Privacy Policy

**Effective date:** 2026-05-23
**Contact:** thejasrao262003@gmail.com

ModPilot is a Reddit moderation tool installed by subreddit moderators. This document explains what data ModPilot processes, why, where it goes, and what your rights are.

## 1. Who we are

ModPilot is a Devvit app for Reddit subreddit moderation. The app is built and operated by Thejas Rao. ModPilot runs inside Reddit's Devvit platform and is invoked by moderators of subreddits where it is installed.

## 2. What data we process

When a moderator invokes "Investigate with ModPilot" on a post or comment, the app processes:

- **Post/comment ID and body** — the text content being investigated
- **Reddit username and user ID** of the post/comment author
- **Reddit username and user ID** of the invoking moderator
- **Subreddit ID and name** in which the app is installed
- **Report metadata** — count of reports on the target, when reports were made
- **Subreddit configuration** — the moderation rules, personality preset, and region the mod team configured for the subreddit
- **Moderation history** — when the subreddit's mods previously took actions (remove/approve/lock) on the same author or target

We do **not** collect or process:

- Real-world identity information (names, addresses, phone numbers)
- Email addresses or other contact data
- Reddit account passwords or authentication tokens
- Content from subreddits where ModPilot is not installed
- Direct messages or private chats

## 3. How and where data is processed

- **Devvit-managed Redis (Reddit infrastructure)** — moderation memory, investigation records, configuration. All keys are scoped to the installing subreddit; data is never shared across subreddits. Operated by Reddit, governed by Reddit's data policies.
- **Google Gemini API (Google Cloud)** — when an investigation runs, the target's post/comment text plus the subreddit's configured rules are sent to Google's Gemini 2.5 Pro and 2.5 Flash models to produce a moderation recommendation. Google's API usage is governed by Google Cloud's data policies. Google does not use this data to train models per the Gemini API terms.

We do **not** transmit data to any other third party.

## 4. Why we process this data

To fulfill the moderation use case the subreddit installed ModPilot for:

- Generating a moderation recommendation for a reported post/comment
- Showing the recommendation to the moderator with the evidence trail
- Recording the moderator's decision so the system can learn from feedback
- Maintaining per-subreddit moderation memory (repeat-offender detection, alignment statistics)
- Generating optional draft moderator-to-author messages on request

## 5. Subreddit isolation

ModPilot's data model strictly scopes every record to the subreddit where it was created. A subreddit's moderation memory, investigation history, and configuration are not exposed to or used by any other subreddit. This is enforced in code via subreddit-id-prefixed storage keys.

## 6. Data retention

- **Investigation records and verdicts**: 7 days
- **Feedback records (moderator actions)**: 7 days
- **Moderation memory (per-user counters)**: indefinite for the lifetime of the app's installation on the subreddit
- **Subreddit configuration**: indefinite for the lifetime of the app's installation

When a subreddit uninstalls ModPilot, all Devvit-managed Redis data tied to that installation is cleared by Reddit per Devvit platform behavior.

## 7. Moderator visibility

Moderators of the subreddit where ModPilot is installed can see:
- All investigations run on their subreddit
- All recommendations produced
- All moderator actions taken via ModPilot
- Aggregate stats: investigation counts, alignment rates, total LLM cost

Non-moderators cannot invoke ModPilot's investigation or action endpoints; verdict UI is restricted to the subreddit's mod queue (not visible in the public feed).

## 8. Human-in-the-loop

ModPilot **never takes autonomous moderation actions**. Every Remove / Approve / Lock / Escalate / Reply requires an explicit click by a logged-in human moderator of the subreddit. This is enforced at the API boundary via moderator authorization checks.

## 9. Your rights

If you are a Reddit user whose content was investigated by ModPilot:

- **Right to access**: contact us at the email above to request a copy of any records tied to your username on a subreddit where ModPilot is installed.
- **Right to deletion**: contact us to request deletion of records tied to your username. Note that aggregate counters may not be reversible; specific records will be removed.
- **Right to opt out**: ModPilot processes only content posted to subreddits where the moderators have installed it. The way to opt out is to not post to such subreddits, or to ask the subreddit's moderators not to use ModPilot.

## 10. Children

ModPilot is not intended for use by individuals under 13 years of age. Reddit's own minimum age applies.

## 11. Changes to this policy

Material changes to this policy will be communicated via the app's listing on developers.reddit.com and via modmail to installing subreddits. The latest version is always available at this URL.

## 12. Contact

For privacy questions or data requests: **thejasrao262003@gmail.com**
