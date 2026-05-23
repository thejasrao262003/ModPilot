# ModPilot — Terms & Conditions

**Effective date:** 2026-05-23
**Contact:** thejasrao262003@gmail.com

These Terms govern your use of the ModPilot Devvit app. By installing or using ModPilot, you (the installing subreddit's moderators) agree to these Terms.

## 1. What ModPilot is

ModPilot is a moderation assistance tool for Reddit subreddits. It runs inside Reddit's Devvit platform. When a moderator invokes it on a reported post or comment, ModPilot runs an automated investigation (user history, thread context, rule match, report patterns, prior actions), produces a recommendation with cited evidence, and surfaces it to the moderator. ModPilot does not take moderation actions on its own — every action requires an explicit moderator click.

## 2. Who can use ModPilot

ModPilot may be installed and invoked only by moderators of the subreddit where it is installed. Moderator status is verified at runtime against Reddit's subreddit moderator list. Non-moderators cannot trigger investigations or actions; verdict UI is restricted to the subreddit's mod queue.

## 3. Acceptable use

You agree to use ModPilot only:

- In subreddits where you are a moderator
- For the purpose of moderating content in line with Reddit's site-wide content policies and your subreddit's own rules
- In compliance with applicable laws

You agree **not** to use ModPilot to:

- Circumvent Reddit's platform policies
- Mass-action content without individual moderator review
- Harass, target, or discriminate against any user
- Train external models on data extracted via the app
- Reverse-engineer or attempt to bypass the app's authorization checks

## 4. Reliance on the recommendation

ModPilot's recommendations are **informational**. The moderator is solely responsible for every action taken. ModPilot's outputs are not guaranteed to be accurate, complete, or appropriate for every case. The calibrated confidence and rule-match signals are heuristics, not certainties. By using ModPilot you acknowledge that final moderation judgment is yours.

## 5. Third-party services

ModPilot calls Google's Gemini API to produce recommendations and draft messages. Use of ModPilot constitutes your acceptance that the content being investigated will be transmitted to Google's API endpoints for processing. Google's API usage is governed by Google Cloud's terms; Gemini API content is not used to train Google's models per Google's published policies.

ModPilot persists data in Devvit-managed Redis (Reddit infrastructure). Use of ModPilot constitutes your acceptance of Reddit's data handling for installed Devvit apps.

## 6. Service availability

ModPilot is provided "as is" without warranty of any kind. We make no guarantee of uptime, latency, or correctness. The app may be unavailable due to:

- Reddit Devvit platform issues
- Google Gemini API rate limits or outages
- Updates being rolled out

When ModPilot is unavailable, Reddit's native mod queue continues to function. ModPilot is augmentation, not a replacement.

## 7. Limitation of liability

To the maximum extent permitted by law, ModPilot's operators are not liable for:

- Decisions made by moderators based on ModPilot's recommendations
- Removal or approval of content via moderator-initiated actions through ModPilot
- Any indirect, incidental, or consequential damages arising from use of the app

The moderator's decision is the operative action; ModPilot's role is to surface information.

## 8. Costs

ModPilot uses Google Gemini API calls that incur cost at usage time. While the hackathon-submitted version of ModPilot does not charge moderators directly, future versions may require the installing subreddit to provide their own Gemini API key. The currently published version operates against the developer's API key at the developer's expense and is not guaranteed to remain free indefinitely.

## 9. Termination

Subreddit moderators may uninstall ModPilot at any time via Reddit's app management. Upon uninstall, ModPilot stops processing content from that subreddit. The developer may discontinue ModPilot, change its functionality, or remove it from the Reddit Apps directory at any time.

## 10. Changes to these Terms

Material changes will be announced via the app's developers.reddit.com listing and via modmail to installing subreddits. Continued use after a change constitutes acceptance.

## 11. Governing law

These Terms are governed by the law of the developer's jurisdiction. Reddit's own Terms of Service apply in parallel to all Devvit apps.

## 12. Contact

For questions about these Terms: **thejasrao262003@gmail.com**
