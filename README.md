# Twitter Archive Expander

### Description

This tool is intended to download full, extended-mode versions of a user's tweets found in their archive. The tweet versions in current archives are truncated, and do not include retweeted/quoted tweets, so this allows expanding the archive to include all tweet elements accessible via Twitter's 1.1 API.

#### Usage

```
twitter_archive_expander.py [-h] [-c CREDS_DIR] [-m FETCH_MAX] ARCHIVE

Parses a Twitter archive and fetches extended versions of tweets.

positional arguments:
  ARCHIVE               Extracted Twitter archive directory

options:
  -h, --help            show this help message and exit
  -c CREDS_DIR, --creds-dir CREDS_DIR
                        Directory to find/store access credentials (default current directory)
  -m FETCH_MAX, --fetch-max FETCH_MAX
                        Maximum number of tweets to fetch from the API
```

### Installation

Clone the repository:

```bash
git clone git@github.com:rneilson/twarc.git
```

or

```bash
git clone https://github.com/rneilson/twarc.git
```

Install a Python virtualenv and dependencies:

```bash
cd twarc
python3 -m venv .venv
source .venv/bin/activate
pip3 install -r requirements.txt
```

### Credentials

`twitter_archive_expander` will prompt for a consumer key and secret on first run - these can be [obtained with a Twitter developer account](https://developer.twitter.com/en/docs/authentication/oauth-1-0a/api-key-and-secret). It will then present a Twitter URL to open in the browswer for authorization. The authorizing user must match the user for the archive.

Credentials are stored in the current directory by default; use the `--creds-dir` option to specify an alternate location. Multiple users will each require their own authorization, but may use the same consumer key/secret.

### Licence

Made available under the [Apache 2.0 license](LICENSE.txt).
