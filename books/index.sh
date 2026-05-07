source ../.env
curl -XDELETE "$BONSAI_URL/books"
curl -XPUT "$BONSAI_URL/books" -H "Content-Type:application/json" --data-binary @books-index.json
for i in ./bulk/books-*.ndjson
do
    curl -XPOST "$BONSAI_URL/_bulk" -H "Content-Type:application/x-ndjson" --data-binary @$i >> logs.ndjson
    echo $i
done
echo "Done!"
