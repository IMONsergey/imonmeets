# IMON Meets interface

## Direction

The interface follows the current Zoom Workplace desktop layout at the owner's request. Keep the IMON Meets name and existing product behavior. Use the application as the reference, including its navigation, density and meeting controls.

Primary visual sources:

- [Zoom Workplace interface changes](https://www.zoom.com/en/blog/zoom-workplace-simplicity-ui-updates/)
- [Official Home screenshot](https://assets.zoom.us/images/en-us/desktop/generic/workplace-desktop-app-home-tab.png)
- [Official meeting screenshot](https://assets.zoom.us/images/en-us/desktop/generic/in-meeting/meeting-controls-with-marketing-images.png)

The values below are our implementation choices based on those screenshots. They are not represented as an exported or complete official Zoom token library. No Zoom logo, proprietary font or screenshot is shipped in the application.

## Shared tokens

| Purpose                  | Value                                |
| ------------------------ | ------------------------------------ |
| Primary action           | `#0b5cff`                            |
| Primary hover            | `#004ce5`                            |
| Selected background      | `#e8f0ff`                            |
| Main text                | `#232333`                            |
| Secondary text           | `#6e6e73`                            |
| Borders                  | `#e0e0e6`                            |
| Main surface             | `#ffffff`                            |
| Secondary surface        | `#f7f7f8`                            |
| Application chrome       | `#e9eaed`                            |
| New meeting shortcut     | `#ff7420`                            |
| Success                  | `#16803c`                            |
| Destructive action       | `#d92d20`                            |
| Body type                | System sans / Segoe UI / Arial, 14px |
| Input and button corners | 8px                                  |
| Panels and dialogs       | 10–12px                              |
| Navigation rail          | 76px                                 |
| Application header       | 56px                                 |

`apps/web/src/styles.css` owns shared tokens, controls, the shell, meeting lists and agenda. Page-specific styles live in `styles/auth.css`, `styles/call.css` and `styles/workspace.css`. Remove replaced rules instead of layering another theme over obsolete CSS.

## Layout rules

- Use a narrow cool-gray icon rail, a compact header and a white working surface. The account menu must remain available on mobile, including sign-out.
- Home contains the clock/date, four real shortcuts and a date-browsable agenda. Load the complete meeting list; the overview endpoint's recent-item limit is not suitable for the agenda.
- Start Meeting is the only orange home shortcut. Other primary actions use blue.
- Lists use fine dividers and restrained metadata. Avoid large individually elevated cards for each meeting.
- Account pages use a centered, compact form. No decorative hero, marketing illustration or slogan belongs inside the application.
- The call fills the available window with a dark video canvas and a flat control bar. Screen sharing is green; leaving or closing a meeting is red. Chat and device settings use white panels.
- At narrow widths, navigation becomes a bottom bar. Forms remain readable, and dialogs scroll within the viewport.
- Only expose working controls. Do not add placeholder AI, phone, whiteboard, SSO or payment controls to resemble another product.

## Working interactions added with the redesign

Header search filters the existing meeting list, including repeated searches while already on that page. The plus shortcut opens the existing meeting editor. The Home join dialog accepts an IMON meeting link or its code and rejects external-origin links. Agenda date arrows and Today use the browser's local date. Settings sections stop device preview when leaving the device panel.

## Verification scope

On 2026-11-01, strict project type checking, the production frontend build and formatting passed. A Chrome visual check exercised 15 desktop/mobile views at 1440px and 390px, using isolated synthetic API fixtures. No horizontal overflow or browser runtime errors were found. Header search, rejection of an external join link and mobile account sign-out passed through the UI.

Those fixture checks establish layout and interface behavior, not live video connectivity. The separate credentialed `tests/e2e/review.spec.ts` checks the deployed real API, calendar download, two-browser media/chat and room closure. Its documented external-network limitations continue to apply.
