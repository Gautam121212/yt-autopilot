# Updating without clobbering your config

`unzip -o` overwrites everything, including `config/channel.json` (your channel name, cadence),
`config/playbook.md` (everything the learning loop has written) and `config/learned.json`.

Update code only:

```bash
cd ~/Downloads
rm -rf yt-autopilot-new && mkdir yt-autopilot-new
unzip -q yt-autopilot.zip -d yt-autopilot-new
cd yt-autopilot
rsync -a --delete yt-autopilot-new/yt-autopilot/src/ src/
rsync -a --delete yt-autopilot-new/yt-autopilot/scripts/ scripts/
rsync -a --delete yt-autopilot-new/yt-autopilot/.github/ .github/
cp yt-autopilot-new/yt-autopilot/{package.json,tsconfig.json,db/schema.sql} . 2>/dev/null || true
cp yt-autopilot-new/yt-autopilot/db/schema.sql db/schema.sql
cp yt-autopilot-new/yt-autopilot/*.md .
rm -rf ~/Downloads/yt-autopilot-new
npm install && npm run migrate && npm run preflight
```

Your `.env`, `config/channel.json`, `config/playbook.md` and `config/learned.json` are never touched.
Once the project is on GitHub, prefer editing in the repo and pushing with `npm run github`.
