const fs = require("fs");
const path = require("path");

const dataPath = path.join(
  __dirname,
  "chinook-database/ChinookDatabase/DataSources/ChinookData.json",
);
const outPath = path.join(__dirname, "music.ndjson");

const data = JSON.parse(fs.readFileSync(dataPath, "utf-8"));

// --- Lookup maps ---

const genreById = Object.fromEntries(
  data.Genre.map((g) => [g.GenreId, g.Name]),
);

const mediaTypeById = Object.fromEntries(
  data.MediaType.map((m) => [m.MediaTypeId, m.Name]),
);

const artistById = Object.fromEntries(
  data.Artist.map((a) => [a.ArtistId, a.Name]),
);

const albumById = Object.fromEntries(
  data.Album.map((a) => [a.AlbumId, a.Title]),
);

const customerById = Object.fromEntries(
  data.Customer.map((c) => [
    c.CustomerId,
    { name: `${c.FirstName} ${c.LastName}`, id: c.CustomerId },
  ]),
);

const employeeById = Object.fromEntries(
  data.Employee.map((e) => [e.EmployeeId, `${e.FirstName} ${e.LastName}`]),
);

// --- Helpers ---

function filterEmpty(arr) {
  return arr.filter((v) => v !== null && v !== undefined && v !== "");
}

function toISO(dateStr) {
  if (!dateStr) return null;
  // Source dates look like "2002-08-14T00:00:00" — append Z
  return dateStr.endsWith("Z") ? dateStr : dateStr + "Z";
}

function maybeSet(doc, field, value) {
  if (Array.isArray(value)) {
    const cleaned = filterEmpty(value);
    if (cleaned.length > 0) doc[field] = cleaned;
  } else if (value !== null && value !== undefined && value !== "") {
    doc[field] = value;
  }
}

// --- Transform each table ---

const lines = [];

function emit(id, doc) {
  lines.push(JSON.stringify({ index: { _index: "music", _id: id } }));
  lines.push(JSON.stringify(doc));
}

// Artist
for (const r of data.Artist) {
  const id = `artist-${r.ArtistId}`;
  const doc = { id, type: "artist", permissions: ["all"] };
  maybeSet(doc, "names", [r.Name]);
  emit(id, doc);
}

// Album
for (const r of data.Album) {
  const id = `album-${r.AlbumId}`;
  const doc = { id, type: "album", permissions: ["all"] };
  maybeSet(doc, "names", [r.Title]);
  maybeSet(doc, "aka", [artistById[r.ArtistId]]);
  emit(id, doc);
}

// Track
for (const r of data.Track) {
  const id = `track-${r.TrackId}`;
  const doc = { id, type: "track", permissions: ["all"] };
  maybeSet(doc, "names", [r.Name]);
  maybeSet(doc, "aka", [
    albumById[r.AlbumId],
    genreById[r.GenreId],
    r.Composer,
  ]);
  if (r.UnitPrice != null) doc.amount = Math.round(r.UnitPrice * 100);
  const details = {};
  if (mediaTypeById[r.MediaTypeId])
    details.media_type = mediaTypeById[r.MediaTypeId];
  if (r.Milliseconds != null) details.duration_ms = r.Milliseconds;
  if (r.Bytes != null) details.size_bytes = r.Bytes;
  if (Object.keys(details).length > 0) doc.details = details;
  emit(id, doc);
}

// Customer
for (const r of data.Customer) {
  const id = `customer-${r.CustomerId}`;
  const doc = {
    id,
    type: "customer",
    permissions: [`customer-${r.CustomerId}`, "admin"],
  };
  maybeSet(doc, "names", [`${r.FirstName} ${r.LastName}`]);
  maybeSet(doc, "aka", [r.Company]);
  maybeSet(doc, "emails", [r.Email]);
  maybeSet(doc, "address", [
    r.Address,
    r.City,
    r.State,
    r.Country,
    r.PostalCode,
  ]);
  maybeSet(doc, "notes", [r.Phone, r.Fax]);
  const details = {};
  if (r.SupportRepId && employeeById[r.SupportRepId])
    details.support_rep = employeeById[r.SupportRepId];
  if (Object.keys(details).length > 0) doc.details = details;
  emit(id, doc);
}

// Employee
for (const r of data.Employee) {
  const id = `employee-${r.EmployeeId}`;
  const doc = { id, type: "employee", permissions: ["admin"] };
  maybeSet(doc, "names", [`${r.FirstName} ${r.LastName}`]);
  maybeSet(doc, "aka", [r.Title]);
  maybeSet(doc, "emails", [r.Email]);
  maybeSet(doc, "address", [
    r.Address,
    r.City,
    r.State,
    r.Country,
    r.PostalCode,
  ]);
  maybeSet(doc, "notes", [r.Phone, r.Fax]);
  maybeSet(doc, "created", toISO(r.HireDate));
  const details = {};
  if (r.BirthDate) details.birth_date = toISO(r.BirthDate);
  if (r.ReportsTo && employeeById[r.ReportsTo])
    details.reports_to = employeeById[r.ReportsTo];
  if (Object.keys(details).length > 0) doc.details = details;
  emit(id, doc);
}

// Invoice
for (const r of data.Invoice) {
  const id = `invoice-${r.InvoiceId}`;
  const cust = customerById[r.CustomerId];
  const doc = {
    id,
    type: "invoice",
    permissions: [`customer-${r.CustomerId}`, "admin"],
  };
  if (cust) maybeSet(doc, "names", [cust.name]);
  maybeSet(doc, "address", [
    r.BillingAddress,
    r.BillingCity,
    r.BillingState,
    r.BillingCountry,
    r.BillingPostalCode,
  ]);
  maybeSet(doc, "created", toISO(r.InvoiceDate));
  if (r.Total != null) doc.amount = Math.round(r.Total * 100);
  emit(id, doc);
}

// Playlist
for (const r of data.Playlist) {
  const id = `playlist-${r.PlaylistId}`;
  const doc = { id, type: "playlist", permissions: ["all"] };
  maybeSet(doc, "names", [r.Name]);
  emit(id, doc);
}

// --- Write output ---

// Bulk NDJSON must end with a newline
fs.writeFileSync(outPath, lines.join("\n") + "\n", "utf-8");

const docCount = lines.length / 2;
console.log(`Wrote ${docCount} documents to ${outPath}`);
