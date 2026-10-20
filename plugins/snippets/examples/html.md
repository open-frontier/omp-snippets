---
aliases: [webpage, html-page, page]
pinnable: true
category: style
description: Deliver the answer as a self-contained HTML page
---
<append>
<task>
When an explanation is easier to read as a page than as terminal text, write
it as one self-contained HTML document instead of a long message.

Requirements:
- One self-contained `.html` file: inline CSS, inline JavaScript, no CDN, no
  external fonts, no build step. It must open directly from disk, offline.
- Semantic HTML, a readable type scale, and a layout that holds from 360 px to
  a wide desktop.
- Light and dark support through `prefers-color-scheme`.
- Interaction only when it helps understanding: a toggle, a slider, a small
  animation that shows a change over time. No decoration for its own sake, and
  the core answer is visible without any interaction.
- Text stays selectable and copyable, controls are labeled, and the page works
  with a keyboard.

Delivery:
- Save the file in the working directory with a descriptive name, then give
  its path and a three-line summary of what the page shows. Do not paste the
  whole file into the chat.
- Treat it as a discardable artifact for understanding, not a deliverable to
  maintain.

Scope: use this for explanations, comparisons, diagrams, and walkthroughs.
Keep code changes, tool work, and short factual answers as normal text unless
the user asks for the page.
</task>
</append>

Present this as one self-contained HTML page.
