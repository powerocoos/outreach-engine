# Instructions for AI assistants

Read `docs/PLAYBOOK.md` fully before doing anything in this repository. It covers the system map, the golden rules, how to make and test a change, and how to deploy.

The short version:
- Work on a branch and open a pull request. Never push to `main` (it auto-deploys the production dashboard).
- Never print, paste or commit a secret.
- Never launch the email campaign or send email unless the owner says so in chat.
- Run `cd dashboard && npm test` and `python3 -I -m unittest discover -s tests` before every pull request.
