#!/usr/bin/env bash
# Captures every overlay graphic from the dev server (node overlays/_shared/devserver.mjs)
# with headless Chrome into docs/shots/*.png. Transparent overlay bodies are
# composited on the checkerboard-ish graphite so the plates read.
#   bash docs/shots/shoot.sh            # all
#   bash docs/shots/shoot.sh cs2        # filter by name substring
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
BASE=http://127.0.0.1:7710
OUT="$(cd "$(dirname "$0")" && pwd)"
FILTER="${1:-}"
post() { curl -s -o /dev/null -X POST "$BASE/api/state" -H 'Content-Type: application/json' -d "$1"; }
# Switch the dev server onto a game and let that game's simulator warm up. Without
# this every pack is shot against whatever feed happened to be running, so the bugs
# that read per-game fields (Apex squads, Dota gold, FGC games) come out blank.
WARM="${WARM:-40}"
game() { curl -s -o /dev/null -X POST "$BASE/api/game" -H 'Content-Type: application/json' -d "{\"game\":\"$1\"}"; sleep "${2:-$WARM}"; }
shot() {  # name page patch
  [[ -n "$FILTER" && "$1" != *"$FILTER"* ]] && return
  post "$3"
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --window-size=1920,1080 --default-background-color=1A1E25FF \
    --virtual-time-budget=5000 --screenshot="$(cygpath -w "$OUT/$1.png")" "$BASE/packs/$2" >/dev/null 2>&1
  echo "shot $1"
}
IN5=$(date -u -d '+5 minutes' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || python -c "import datetime;print((datetime.datetime.utcnow()+datetime.timedelta(minutes=5)).strftime('%Y-%m-%dT%H:%M:%SZ'))")
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
post '{"show":{"timeout":null,"bug":true,"ticker":true,"corner":true,"lowerThird":{"on":true,"name":"Riley","role":"CASTER","handle":"@rileycasts"}},"live":{"connected":true}}'
for c in vs veto roster bracket scoreboard mvp h2h schedule; do shot "valorant-cards-$c" valorant/overlay/cards.html "{\"show\":{\"card\":\"$c\"}}"; done
shot cs2-cards-veto-fallback cs2/overlay/cards.html '{"show":{"card":"veto"}}'
shot rocketleague-cards-vs rocketleague/overlay/cards.html '{"show":{"card":"vs"}}'
shot valorant-ingame-live valorant/overlay/ingame.html '{"live":{"connected":true}}'
shot valorant-ingame-timeout valorant/overlay/ingame.html "{\"show\":{\"timeout\":{\"reason\":\"TACTICAL TIMEOUT\",\"seconds\":60,\"startedAt\":\"$NOW\"}}}"
shot valorant-ingame-series valorant/overlay/ingame.html '{"show":{"timeout":null},"live":{"connected":false}}'
post '{"live":{"connected":true}}'
for g in cs2 rocketleague lol dota2 apex fgc eafc; do
  [[ -n "$FILTER" && "$g-ingame" != *"$FILTER"* ]] && continue   # no warm-up wait for a title the filter skips
  game "$g"; shot "$g-ingame" $g/overlay/ingame.html '{}'
done
shot valorant-standby-countdown valorant/overlay/standby.html "{\"show\":{\"standby\":{\"mode\":\"countdown\",\"targetAt\":\"$IN5\",\"title\":\"STARTING SOON\",\"sub\":\"SEMI-FINAL 1 \u00b7 ALPHA vs BRAVO\"}}}"
shot valorant-standby-brb valorant/overlay/standby.html '{"show":{"standby":{"mode":"brb","sub":"TECHNICAL PAUSE"}}}'
shot valorant-standby-outro valorant/overlay/standby.html '{"show":{"standby":{"mode":"outro"}}}'
shot valorant-desk-casters "valorant/overlay/desk.html?who=casters" '{}'
shot valorant-desk-hosts "valorant/overlay/desk.html?who=hosts" '{"show":{"deskTopic":"Can Bravo close it out on Haven?"}}'

# --- the headline card each title leads with --------------------------------
# One card per game, not one card for all games: a Rocket League series board and
# a League draft are different graphics, and neither is a map veto. Shot with real
# data because an empty card proves nothing.
game valorant 2

DRAFT='{"show":{"card":"draft"},"draft":{"steps":[
 {"action":"ban","team":"alpha","champion":"Kalista"},{"action":"ban","team":"bravo","champion":"Azir"},
 {"action":"ban","team":"alpha","champion":"Rell"},{"action":"ban","team":"bravo","champion":"Neeko"},
 {"action":"ban","team":"alpha","champion":"Vi"},{"action":"ban","team":"bravo","champion":"Ashe"},
 {"action":"pick","team":"alpha","champion":"Aatrox","ign":"Zephyr"},
 {"action":"pick","team":"bravo","champion":"Ksante","ign":"Rift"},
 {"action":"pick","team":"bravo","champion":"Sejuani","ign":"Ember"},
 {"action":"pick","team":"alpha","champion":"Maokai","ign":"Kestrel"},
 {"action":"pick","team":"alpha","champion":"Orianna","ign":"Onyx"},
 {"action":"pick","team":"bravo","champion":"Corki","ign":"Nomad"},
 {"action":"pick","team":"bravo","champion":"Varus","ign":"Static"},
 {"action":"pick","team":"alpha","champion":"Rakan","ign":"Talon"},
 {"action":"pick","team":"alpha","champion":"Jinx","ign":"Ronin"},
 {"action":"pick","team":"bravo","champion":"Nautilus","ign":"Quartz"}]}}'
shot lol-cards-draft lol/overlay/cards.html "$DRAFT"
shot dota2-cards-draft dota2/overlay/cards.html '{"show":{"card":"draft"},"draft":{"steps":[
 {"action":"ban","team":"alpha","champion":"Muerta"},{"action":"ban","team":"bravo","champion":"Primal Beast"},
 {"action":"ban","team":"alpha","champion":"Tidehunter"},{"action":"ban","team":"bravo","champion":"Enigma"},
 {"action":"pick","team":"alpha","champion":"Mars","ign":"Zephyr"},
 {"action":"pick","team":"bravo","champion":"Dawnbreaker","ign":"Rift"},
 {"action":"pick","team":"bravo","champion":"Hoodwink","ign":"Ember"},
 {"action":"pick","team":"alpha","champion":"Puck","ign":"Kestrel"},
 {"action":"pick","team":"alpha","champion":"Juggernaut","ign":"Onyx"},
 {"action":"pick","team":"bravo","champion":"Lion","ign":"Nomad"},
 {"action":"pick","team":"bravo","champion":"Medusa","ign":"Static"},
 {"action":"pick","team":"alpha","champion":"Rubick","ign":"Talon"},
 {"action":"pick","team":"alpha","champion":"Clockwerk","ign":"Ronin"},
 {"action":"pick","team":"bravo","champion":"Undying","ign":"Quartz"}]}}'

# Twenty squads, which is what makes the two-column split necessary at all.
ROWS=""
i=0
for sq in ALPHA BRAVO "TEAM FALCON" "AURORA GG" "REIGN ESPORTS" "NOVA COLLECTIVE" "PHANTOM UNIT" "SABLE SIX" "VOLT GAMING" "OUTLAW APEX" "KESTREL" "IRON WOLVES" "DEEP SIX" "HALO NINE" "RIFT RAIDERS" "SOLAR FLARE" "NIGHT MARKET" "BRASS TACKS" "LOW ORBIT" "FINAL CALL"; do
  i=$((i+1))
  pts=$(( 120 - i*5 + (i%3)*4 )); kl=$(( 40 - i + (i%4)*2 ))
  [ -n "$ROWS" ] && ROWS="$ROWS,"
  ROWS="$ROWS{\"team\":\"$sq\",\"games\":6,\"kills\":$kl,\"points\":$pts}"
done
game apex 2
shot apex-cards-standings apex/overlay/cards.html "{\"show\":{\"card\":\"standings\"},\"standings\":{\"matchPoint\":50,\"rows\":[$ROWS]}}"

game fgc 2
shot fgc-cards-set fgc/overlay/cards.html '{"show":{"card":"set"},"series":{"format":"FT3"},"set":{"title":"Street Fighter 6","games":[
 {"a":"Ken","b":"JP","winner":"bravo"},
 {"a":"Ken","b":"JP","winner":"alpha"},
 {"a":"Cammy","b":"JP","winner":"alpha"},
 {"a":"Cammy","b":"Akuma","winner":"bravo"},
 {"a":"Cammy","b":"Akuma","winner":"alpha"}]}}'

game rocketleague 2
shot rocketleague-cards-games rocketleague/overlay/cards.html '{"show":{"card":"games"},"series":{"format":"BO5","scoreA":2,"scoreB":1,"maps":[
 {"name":"","status":"done","scoreA":3,"scoreB":1,"winner":"alpha"},
 {"name":"","status":"done","scoreA":0,"scoreB":2,"winner":"bravo"},
 {"name":"","status":"done","scoreA":4,"scoreB":3,"winner":"alpha"},
 {"name":"","status":"live","scoreA":1,"scoreB":1},
 {"name":"","status":"upcoming","scoreA":0,"scoreB":0}]}}'

game eafc 2
shot eafc-cards-matchstats eafc/overlay/cards.html '{"show":{"card":"matchstats"},"matchStats":{
 "rows":[{"label":"Possession","a":57,"b":43,"unit":"%"},{"label":"Shots","a":14,"b":9},
         {"label":"On target","a":6,"b":3},{"label":"Corners","a":7,"b":2},
         {"label":"Fouls","a":8,"b":13,"lowerIsBetter":true},{"label":"Pass accuracy","a":88,"b":81,"unit":"%"}],
 "scorers":[{"team":"alpha","ign":"Zephyr","minute":23},{"team":"bravo","ign":"Rift","minute":41},
            {"team":"alpha","ign":"Onyx","minute":67},{"team":"alpha","ign":"Zephyr","minute":90}]}}'

# The stats card fed by each title's live simulator (the scoreboard reads the feed, not the desk).
post '{"draft":null,"standings":null,"set":null,"matchStats":null}'
for g in apex dota2 eafc rocketleague; do
  [[ -n "$FILTER" && "$g-cards-scoreboard-live" != *"$FILTER"* ]] && continue
  game "$g"; shot "$g-cards-scoreboard-live" $g/overlay/cards.html '{"show":{"card":"scoreboard"}}'
done
# A card the title refuses: Rocket League has no map veto, so the card says so.
if [[ -z "$FILTER" || "rocketleague-cards-veto-refused" == *"$FILTER"* ]]; then
  game rocketleague 8   # its own simulator, so the SIM flag names the right title
  shot rocketleague-cards-veto-refused rocketleague/overlay/cards.html '{"show":{"card":"veto"}}'
fi
# What OBS program shows in 04 IN-GAME over a black capture: the bug and ticker. 960x540.
if [[ -z "$FILTER" || "obs_program_04" == *"$FILTER"* ]]; then
  game cs2
  post '{"show":{"card":null,"bug":true,"ticker":true,"corner":true}}'
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --window-size=1920,1080 --force-device-scale-factor=0.5 \
    --default-background-color=000000FF --virtual-time-budget=5000 \
    --screenshot="$(cygpath -w "$OUT/obs_program_04.png")" "$BASE/packs/cs2/overlay/ingame.html" >/dev/null 2>&1
  echo "shot obs_program_04"
fi

game valorant 2
post '{"show":{"deskTopic":null,"card":"veto","standby":{"mode":"countdown","targetAt":null}},"series":{"format":"BO3"},"draft":null,"standings":null,"set":null,"matchStats":null}'
