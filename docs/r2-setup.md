# Local R2 verification setup

Cloudflare R2 was selected for S04. This guide prepares a private bucket for synthetic verification; it does not approve production residency, company SOP processing or an object recovery policy. Actual bucket/account settings stay in ignored `.local-secrets/s04-r2.env`.

## Server credentials

In Cloudflare, open R2 object storage, then Manage API Tokens. Create an R2 API token with **Object Read & Write**, scoped to the intended bucket. Save the two values shown after creation as raw text in these local files:

- Access Key ID: `C:\Users\mzain\Documents\AI SOP Assistant\.local-secrets\r2-access-key-id`
- Secret Access Key: `C:\Users\mzain\Documents\AI SOP Assistant\.local-secrets\r2-secret-access-key`

Keep both values out of chat, Git, screenshots and logs. The application reads them server-side through individual readonly secret mounts; the local fixture uses different synthetic files. [Cloudflare authentication](https://developers.cloudflare.com/r2/api/tokens/)

The configured S3 endpoint is the account/jurisdiction endpoint without the bucket suffix. The bucket name is a separate setting. Region `auto` is the R2 signing setting; it does not select or approve where data resides. The initial synthetic verification reservation quota is100,000,000 bytes, with each upload reserving twice its declared size for staging and original. The test file limit is20,000,000 bytes. These are explicit verification settings, not approved company limits. [S3 setup and endpoint](https://developers.cloudflare.com/r2/get-started/s3/)

## Private bucket and browser CORS

Keep bucket public access disabled. For the local browser verification origin, set this narrow CORS rule in the bucket settings:

```json
[
  {
    "AllowedOrigins": ["http://127.0.0.1:3000"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["Content-Type", "If-None-Match"],
    "MaxAgeSeconds": 300
  }
]
```

The browser sends a File body, which supplies its actual Content-Length automatically. Backend signing binds that length, content type, create-only header, method and exact staging key. No public download domain is needed. Production origin changes need a separately reviewed rule. [R2 CORS](https://developers.cloudflare.com/r2/buckets/cors/) · [Presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)

## Verification boundary

Use only synthetic files created for S04, with tracked app-owned identities. Never list, replace or delete unrelated bucket objects. Live checks must cover direct browser PUT, expiration/tampering denial, exact-byte finalization, conditional-write races, private access and safe failure/retry. Record sanitized status/count evidence; never publish signed URLs or credential values.

Staging objects and reservations remain accounted for until cleanup/recovery policy is reviewed. An expired URL or negative HEAD cannot prove that an earlier in-flight PUT will never commit. Accepted originals use a separate server-only conditional-write key. [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/) · [Conditional operations](https://developers.cloudflare.com/r2/api/s3/conditional-operations/)

The live R2 gate remains open until real synthetic checks pass. Local Wrangler checks establish only their measured fixture behavior. See [S04 contract](private-uploads.md).
