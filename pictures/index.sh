source ../.env
curl -XDELETE "$BONSAI_URL/pictures"
curl -XPUT "$BONSAI_URL/pictures" -H "Content-Type:application/json" --data-binary @pictures-index.json

# Bulk file carries base64 images + 1152-dim vectors, so split into
# chunks of 100 lines (50 docs) to keep each request small.
rm -f logs.ndjson bulk-chunk-*
split -l 100 pictures.ndjson bulk-chunk-
for f in bulk-chunk-*
do
    curl -s -XPOST "$BONSAI_URL/_bulk" -H "Content-Type:application/x-ndjson" --data-binary @$f >> logs.ndjson
    echo $f
done
rm -f bulk-chunk-*
echo "Done!"
