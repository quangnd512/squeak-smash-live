/*
  Squeak Smash! : what Goldie and Pip say after every round.
  Edit this file to change the lines, then rebuild the site (docker compose up -d --build).
  A line is a piece of text between quotes, followed by a comma. Keep the quotes and commas.

  goldie : shown when the player beats their own best score (Goldie cheers)
  pip    : shown when the player does NOT beat their best score (Pip teases)

  Lines are shown in order, one after another, so a player sees every line before one repeats.
  Add or remove lines freely (even 1 line works). A line may use these placeholders:
    {score}  the score of the round just played
    {gain}   points above the old best (only used in goldie lines; skipped on a first round)
    {gap}    points short of the best (only used in pip lines; skipped when it is not above 0)
  A line that uses {gain} or {gap} is skipped automatically when the number makes no sense.
  Avoid angle brackets and keep each line under about 60 characters so it fits the speech bubble.
*/
window.SQ_LINES = {
  // how long the full-screen popup stays up, in seconds (a tap or Esc closes it earlier). Allowed: 1 to 15.
  popupSeconds: 4,

  goldie: [
    'New personal best! Golden whack!',
    'That is {score} points! Shiny work!',
    'You just beat your own record. Wow!',
    'Sparkle sparkle! Your best round yet!',
    'I am doing a happy dance for you!',
    'A gold medal hammer arm, right there!',
    '{gain} more than your old best. Impressive!',
    'Even the mice are clapping. Squeak!',
    'Record broken! I knew you could do it.',
    'Your country is proud of you today!'
  ],

  pip: [
    'Is that all? My grandma whacks harder.',
    'Ha! Even the bunnies are laughing.',
    '{gap} points short of your best. So close, so slow!',
    'Were you using your elbow?',
    'Squeak! Is the hammer upside down?',
    'Do not worry, the mice are not scared of you yet.',
    'My tail has more combo than you.',
    'Try again! I promise to hide faster.',
    'You blinked, did you not?',
    'That was a warm-up. Right? Right?'
  ]
};
