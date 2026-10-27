# Create the `wikimedia` index on the multimodal cluster and bulk-load the
# Parquet export from commons-qi-parquet.py with omc-vector-tests' fast-index.
# The cluster embeds `image` into `image__bonsai_multimodal_01` on ingest.
#
#   bash index-wikimedia.sh            # from multimodal/
#
# Re-runs are safe: documents are keyed by pageid, so they overwrite.
# Set FAST_INDEX to use a different loader binary.

source ../.env
FAST_INDEX=${FAST_INDEX:-../../omc-vector-tests/rust/target/release/fast-index}
INDEX=wikimedia

# Create the index only if it doesn't exist yet; never drop an existing one.
status=$(curl -s -o /dev/null -w '%{http_code}' "$BONSAI_MULTIMODAL_URL/$INDEX")
if [ "$status" = "404" ]; then
    curl -s -XPUT "$BONSAI_MULTIMODAL_URL/$INDEX" -H "Content-Type:application/json" \
        --data-binary @wikimedia-index.json
    echo
fi

# Small batches: each doc carries a ~38 KB image, and the proxy embeds every
# one before the bulk request returns.
mkdir -p logs
"$FAST_INDEX" \
    --input 'commons-qi-hf/data/*.parquet' \
    --endpoint "$BONSAI_MULTIMODAL_URL" \
    --index "$INDEX" \
    --id-column pageid \
    --batch-size 50 \
    --log-file logs/wikimedia.log
echo "Done! (details in logs/wikimedia.log)"
