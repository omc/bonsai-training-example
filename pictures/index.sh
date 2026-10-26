source ../.env
curl -XDELETE "$BONSAI_MULTIMODAL_URL/pictures"
curl -XPUT "$BONSAI_MULTIMODAL_URL/pictures" -H "Content-Type:application/json" --data-binary @pictures-index.json

# Bulk file carries base64 images + 768-dim vectors, so split into
# chunks of 200 lines (100 docs) to keep each request small.
cd data
split -l 50 pictures-all-sm-noemb.ndjson bulk-chunk-
for f in bulk-chunk-*; do
    curl -s -XPOST "$BONSAI_MULTIMODAL_URL/_bulk" -H "Content-Type:application/x-ndjson" --data-binary @$f >>logs.ndjson
    echo $f
done
rm -f bulk-chunk-*
echo "Done!"
