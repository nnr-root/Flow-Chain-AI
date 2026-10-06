"""Uploads results to the Cloudflare R2 bucket and returns a 7-day download link (2.4 spec §3.1)."""

import os

PRESIGN_SECONDS = 7 * 24 * 3600


def _client():
    import boto3  # imported lazily so the pure modules stay testable without it

    return boto3.client(
        "s3",
        endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )


def upload(path, key, content_type):
    client = _client()
    bucket = os.environ["R2_BUCKET"]
    client.upload_file(path, bucket, key, ExtraArgs={"ContentType": content_type})
    return client.generate_presigned_url(
        "get_object", Params={"Bucket": bucket, "Key": key}, ExpiresIn=PRESIGN_SECONDS
    )
