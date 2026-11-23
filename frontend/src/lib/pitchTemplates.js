// Ready-made pitches. Short, plain and question-led — the style that gets the most replies.
// Placeholders are filled per recipient; text in [brackets] is for the employee to replace.
export const PITCH_TEMPLATES = [
  {
    id: "intro",
    name: "First introduction",
    subjects: [
      "Quick question, {{firstName}}",
      "Idea for {{companyName|your team}}",
      "{{companyName|Your team}} + [your company]",
    ],
    html: `<p>Hi {{firstName|there}},</p>
<p>I came across {{companyName|your company}} and noticed [something specific about them — a new product, hiring, expansion].</p>
<p>We help [type of company] [the result you deliver, e.g. cut delivery times by weeks] without [the usual pain].</p>
<p>Would it be worth a quick 10-minute call next week to see if this could help you too?</p>
<p>Regards,<br>{{senderName}}</p>`,
  },
  {
    id: "problem",
    name: "Problem → solution",
    subjects: [
      "[Problem] at {{companyName|your company}}?",
      "Fixing [problem] for {{firstName}}",
    ],
    html: `<p>Hi {{firstName|there}},</p>
<p>Many [job titles] tell us that [specific problem] takes too much time and money.</p>
<p>We solved this for [similar customer or industry] by [what you did], and they now [measurable result].</p>
<p>Is this something {{companyName|your team}} is dealing with too?</p>
<p>Thanks,<br>{{senderName}}</p>`,
  },
  {
    id: "meeting",
    name: "Meeting request",
    subjects: [
      "10 minutes next week, {{firstName}}?",
      "Short call about [topic]?",
    ],
    html: `<p>Hi {{firstName|there}},</p>
<p>I'd like to show you how [your service] could help {{companyName|your team}} with [goal].</p>
<p>Would Tuesday or Thursday next week work for a 10-minute call? Happy to fit around your schedule.</p>
<p>Best regards,<br>{{senderName}}</p>`,
  },
  {
    id: "followup1",
    name: "Follow-up 1 (gentle nudge)",
    subjects: ["Re: Quick question, {{firstName}}"],
    html: `<p>Hi {{firstName|there}},</p>
<p>Just bringing my note below back to the top of your inbox — I know things get busy.</p>
<p>Would a short call be useful, or is someone else at {{companyName|your company}} the right person to speak to?</p>
<p>Thanks,<br>{{senderName}}</p>`,
  },
  {
    id: "followup2",
    name: "Follow-up 2 (add value)",
    subjects: ["One more idea for {{companyName|you}}"],
    html: `<p>Hi {{firstName|there}},</p>
<p>One more thought: [a useful tip, short case result or relevant fact for their business].</p>
<p>If that's interesting, I can share how it would work for {{companyName|your team}} — shall I send a short summary?</p>
<p>Regards,<br>{{senderName}}</p>`,
  },
  {
    id: "breakup",
    name: "Last follow-up (polite close)",
    subjects: ["Should I close your file, {{firstName}}?", "Last note from me"],
    html: `<p>Hi {{firstName|there}},</p>
<p>I haven't heard back, so I'll assume the timing isn't right and won't keep following up.</p>
<p>If [the problem you solve] becomes a priority later, just reply to this email and I'll be glad to help.</p>
<p>All the best,<br>{{senderName}}</p>`,
  },
];
