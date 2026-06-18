source ../.env
curl -XDELETE "$BONSAI_URL/music"
curl -XPUT "$BONSAI_URL/music" -H "Content-Type:application/json" --data-binary @music-index.json
curl -s -XPOST "$BONSAI_URL/_bulk" -H "Content-Type:application/x-ndjson" --data-binary @music.ndjson
echo "Done!"
