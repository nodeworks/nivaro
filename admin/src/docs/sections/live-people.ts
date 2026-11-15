import type { DocSection } from '../types.js'

export const livePeopleDocs: DocSection = {
  id: 'live-people',
  label: 'Live: People and Chat',
  content: [
    { type: 'h1', id: 'live-people', text: 'Live: people and chat' },
    {
      type: 'p',
      text: 'Two small signals that tell you who is around and who is talking, without opening anything.'
    },
    { type: 'h2', id: 'queue-team-strip', text: 'Team on a queue' },
    {
      type: 'p',
      text: 'A queue page shows a thin “Team” strip: the people who sit in the owner groups of the workflows the queue draws from, each with a dot. Green is online, amber is away or idle, a hollow dot is out of office, grey is not online. Click the strip for the full list; for someone who is out it says until when and who covers for them.'
    },
    {
      type: 'ul',
      items: [
        'Everyone who can read the queue sees it. It shows only people you could see as online anywhere else (the same visibility rules as the Online list), and never service or bot accounts, suspended or former people.',
        'The dots move on their own while Live updates is Normal. In Calm or Off the strip stays as it was when the page loaded.',
        'A team of more than 200 people lists the first 200 and says how many more.'
      ]
    },
    { type: 'h2', id: 'record-chat-mentions', text: 'Being discussed in chat' },
    {
      type: 'p',
      text: 'When a record has been named in a chat room you are in during the last 14 days, its header shows a small chip: “Being discussed in #ops (3 new)”. Click it to see each room with its message count and open the one you want. It counts a message when it carries the record’s number (the same text chat turns into a record chip, for example when someone uses Send to a room) or a pasted link to the record.'
    },
    {
      type: 'ul',
      items: [
        'Only rooms you are in count: your direct messages and the channels you have joined. A private channel you are not in never shows, and neither does anything for a record you cannot read.',
        'The chip shows counts and room names, never the messages. “New” means messages from other people since you last read that room; muted rooms show none as new.',
        'It updates live in Normal mode; in Calm or Off it is as of the page load.'
      ]
    }
  ]
}
