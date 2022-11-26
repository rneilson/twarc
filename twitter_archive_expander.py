#!/usr/bin/env python3
from __future__ import annotations

import io
import json
import os
import sys
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional, Union

import tweepy
import tweepy.errors
import tweepy.models

class InvalidCredentials(Exception):
    pass

class InvalidUserProfile(Exception):
    pass

class InvalidArchiveFile(Exception):
    pass


### Configuration

def get_base_path(base_dir: Optional[Union[Path, str]]) -> Path:
    if base_dir is None:
        base_dir = Path.cwd()
    if isinstance(base_dir, str):
        base_dir = Path(base_dir)
    if not base_dir.is_dir():
        raise RuntimeError(f'{base_dir} is not a directory or does not exist')
    return base_dir

def load_consumer_creds(consumer_file: Path) -> tuple[str, str]:
    '''
    Reads consumer key and secret from given consumer_file, and returns a
    tuple of consumer key and consumer secret.
    '''
    if not consumer_file.exists():
        raise InvalidCredentials(f'No consumer credentials found at {consumer_file}')
    if not consumer_file.is_file():
        raise RuntimeError(f'{consumer_file} is not a file')
    
    consumer_str = consumer_file.read_text()
    consumer_dict = json.loads(consumer_str)
    if (not isinstance(consumer_dict, dict) or
            'consumer_key' not in consumer_dict or
            'consumer_secret' not in consumer_dict):
        raise RuntimeError(f'Invalid consumer credentials in {consumer_file}')
    
    return consumer_dict['consumer_key'], consumer_dict['consumer_secret']

def get_consumer_creds(consumer_file: Path) -> tuple[str, str]:
    '''
    Prompts for consumer key and secret, then writes to consumer_file.
    '''
    consumer_key = input(
        'Please enter the consumer key for the application:'
    )
    consumer_secret = input(
        'Please enter the consumer secret for the application:'
    )
    if not (consumer_key and consumer_secret):
        raise RuntimeError('No consumer credentials provided')

    consumer_dict = {
        'consumer_key': consumer_key,
        'consumer_secret': consumer_secret,
    }
    consumer_file.write_text(json.dumps(consumer_dict, indent=2))

    return consumer_key, consumer_secret

def ensure_consumer_creds(base_dir: Path) -> tuple[str, str]:
    '''
    Loads consumer key and secret if available in 'consumer.json', or prompts
    for both and writes to file if it does not yet exist.
    '''
    consumer_file = base_dir / 'consumer.json'
    try:
        consumer_key, consumer_secret = load_consumer_creds(consumer_file)
    except InvalidCredentials:
        print('No consumer credentials found.')
        consumer_key, consumer_secret = get_consumer_creds(consumer_file)

    return consumer_key, consumer_secret

def load_access_token(access_file: Path) -> tuple[str, str]:
    '''
    Reads access token and secret from access_file, and returns a tuple of
    access token and access secret.
    '''
    if not access_file.exists():
        raise InvalidCredentials(f'No access credentials found at {access_file}')
    if not access_file.is_file():
        raise RuntimeError(f'{access_file} is not a file')
    
    access_str = access_file.read_text()
    access_dict = json.loads(access_str)
    if (not isinstance(access_dict, dict) or
            'access_token' not in access_dict or
            'access_token_secret' not in access_dict):
        raise RuntimeError(f'Invalid access credentials in {access_file}')
    
    return access_dict['access_token'], access_dict['access_token_secret']

def get_access_token(
    access_file: Path,
    consumer_key: str,
    consumer_secret: str
) -> tuple[str, str]:
    '''
    Performs OAuth dance to acquire user-context access token and secret,
    writes result to access_file, and returns a tuple of access token and
    access secret.
    '''
    user_handler = tweepy.OAuth1UserHandler(
        consumer_key,
        consumer_secret,
        callback='oob',
    )
    auth_url = user_handler.get_authorization_url()

    print(
        f'Open the following URL in your browser, and choose to allow\n'
        f'access to the application:\n'
        f'\n{auth_url}\n'
        f'Then copy the PIN number which appears and type it below.\n'
    )
    pin = input('Please enter the PIN:')
    access_token, access_token_secret = user_handler.get_access_token(pin)

    access_dict = {
        'access_token': access_token,
        'access_token_secret': access_token_secret,
    }
    access_file.write_text(json.dumps(access_dict, indent=2))

    return access_token, access_token_secret

def ensure_access_token(
    base_dir: Path,
    consumer_key: str,
    consumer_secret: str
) -> tuple[str, str]:
    '''
    Loads access token and secret if available in 'access.json', or prompts
    for authorization and writes to file if it does not yet exist.
    '''
    access_file = base_dir / 'access.json'
    try:
        access_token, access_token_secret = load_access_token(access_file)
    except InvalidCredentials:
        print('No access token found.')
        access_token, access_token_secret = get_access_token(
            access_file,
            consumer_key,
            consumer_secret,
        )

    return access_token, access_token_secret

def load_user_profile(user_file: Path) -> dict:
    '''
    Reads user profile from user_file, and returns user profile as dict.
    '''
    if not user_file.exists():
        raise InvalidUserProfile(f'No user profile found at {user_file}')
    if not user_file.is_file():
        raise RuntimeError(f'{user_file} is not a file')
    
    user_str = user_file.read_text()
    user_dict = json.loads(user_str)
    if (not isinstance(user_dict, dict) or
            'id_str' not in user_dict or
            'screen_name' not in user_dict):
        raise RuntimeError(f'Invalid user profile in {user_file}')
    
    return user_dict

def get_user_profile(user_file: Path, api: tweepy.API) -> dict:
    '''
    Retrieves authorized user and pinned tweet in extended form, if applicable,
    writes to user_file, and returns user profile as dict.
    '''
    user = api.verify_credentials(include_email=True)
    user_dict = { **user._json }

    if getattr(user, 'status', None) is not None:
        user_status = api.get_status(
            user.status.id_str,
            trim_user=True,
            include_ext_alt_text=True,
            tweet_mode='extended',
        )
        user_dict['status'] = user_status._json

    user_file.write_text(json.dumps(user_dict, indent=2))

    return user_dict

def ensure_user_profile(base_dir: Path, api: tweepy.API) -> dict:
    '''
    Loads user profile if available in 'user.json', or retrieves using current
    credentials and writes to file if it does not yet exist.
    '''
    user_file = base_dir / 'user.json'
    try:
        user_dict = load_user_profile(user_file)
    except InvalidUserProfile:
        print('No user profile found, retrieving...')
        user_dict = get_user_profile(user_file, api)

    return user_dict

def setup_client(base_dir: Optional[Path]) -> tweepy.API:
    '''
    Ensures consumer creds and access token, and returns instantiated API
    client (v1). If base_dir is None, current working directory is assumed.
    '''
    if base_dir is None:
        base_dir = Path.cwd()

    consumer_key, consumer_secret = ensure_consumer_creds(base_dir)
    access_token, access_token_secret = ensure_access_token(
        base_dir, consumer_key, consumer_secret
    )
    api = tweepy.API(tweepy.OAuth1UserHandler(
        consumer_key, consumer_secret, access_token, access_token_secret,
    ))

    return api


### Parsing

def skip_until_byte(
    source_file: io.BufferedReader,
    target: bytes,
) -> tuple[int, bool]:
    '''
    Reads from source_file until target is found, advancing the reader position
    up to but not including the target's offset. Returns the number of bytes
    skipped, if target was found, and None otherwise.
    '''
    # Due to how peek() is implemented, it returns the entire current buffer,
    # which means handling target bytestrings of length > 1 becomes trickier,
    # so instead we're going to limit to 1 -- really we're only looking for a
    # valid start byte for JSON, not anything more...
    if len(target) != 1:
        raise ValueError('Only single-byte targets allowed')

    offset = 0
    found = False

    while True:
        # First peek to see if next byte match target
        look = source_file.peek(1)

        # Cover the case where we hit EOF before finding target
        if len(look) == 0:
            # Advance file position to EOF and end
            _ = source_file.read(1)
            break

        # Since peek() returns the whole buffer, only check the one byte
        if look[:1] == target:
            found = True
            break
        
        # Advance one byte, let the buffering handle the inefficiency
        read = source_file.read(1)
        # Extra EOF handling just in case
        if len(read) == 0:
            break
        # Otherwise continue
        offset += 1
    
    return offset, found

def parse_js_file_list(file_path: Path) -> list[dict[str, Any]]:
    '''
    Parse JS file at file_path, assuming the assigned global var is a list.
    '''
    with file_path.open('rb') as f:
        skip_until_byte(f, b'[')
        parsed = json.load(f)
    
    if not isinstance(parsed, list):
        raise InvalidArchiveFile(
            f'{file_path} does not contain a list of objects'
        )
    
    return parsed

def parse_js_file_dict(file_path: Path) -> dict[str, Any]:
    '''
    Parse JS file at file_path, assuming the assigned global var is a dict.
    '''
    with file_path.open('rb') as f:
        skip_until_byte(f, b'{')
        parsed = json.load(f)
    
    if not isinstance(parsed, dict):
        raise InvalidArchiveFile(
            f'{file_path} does not contain a dict of values'
        )
    
    return parsed


## Archive contents

@dataclass
class TweetJSON:
    id: int
    user_id: str
    processed: bool = False
    saved_at: Optional[Path] = None
    contents: Optional[dict[str, Any]] = None

    @property
    def id_str(self):
        return str(self.id)

    def __eq__(self, other: TweetJSON) -> bool:
        return self.id == other.id

    def __ne__(self, other: TweetJSON) -> bool:
        return self.id != other.id

    def __lt__(self, other: TweetJSON) -> bool:
        return self.id < other.id

    def __le__(self, other: TweetJSON) -> bool:
        return self.id <= other.id

    def __gt__(self, other: TweetJSON) -> bool:
        return self.id > other.id

    def __ge__(self, other: TweetJSON) -> bool:
        return self.id >= other.id


class TwitterArchiveFolder:
    '''
    Represents an extracted Twitter archive folder, latest version as of 2022.
    '''

    SOURCE_DIR_NAME = 'data'
    TARGET_DIR_NAME = 'expanded'
    ACCOUNT_FILE_NAME = 'account.js'
    TWEET_FILE_NAMES = ('tweets.js', 'tweet.js')

    user_id: str
    base_dir: Path
    tweet_file: Path
    known_tweets: dict[int, TweetJSON]

    def __init__(self, user_id: str, base_dir: Union[Path, str]) -> None:
        self.user_id = user_id
        if isinstance(base_dir, str):
            self.base_dir = Path(base_dir)
        else:
            self.base_dir = base_dir
        self.known_tweets = {}

        src_dir = self.base_dir / self.SOURCE_DIR_NAME

        # Validate user ID from account file
        account_file = src_dir / self.ACCOUNT_FILE_NAME
        account_json = parse_js_file_list(account_file)
        if len(account_json) != 1:
            raise InvalidArchiveFile(f'Invalid account file at {account_file}')
        account_dict = account_json[0]
        account_id = account_dict.get('account', {}).get('accountId', '')
        if account_id != user_id:
            raise InvalidArchiveFile(
                f'Expected account id "{user_id}", '
                f'found archive for "{account_id}"'
            )

        # Ensure tweet file present (one of a couple variations)
        tweet_file_found = False
        for filename in self.TWEET_FILE_NAMES:
            self.tweet_file = src_dir / filename
            if self.tweet_file.is_file():
                tweet_file_found = True
                break
        if not tweet_file_found:
            raise InvalidArchiveFile(f'No tweet file found in {src_dir}')
    
    def _get_tweet_save_path(self, tweet_id: str) -> Path:
        '''
        Construct path to save tweet in JSON form.
        '''
        path = self.base_dir.joinpath(
            self.TARGET_DIR_NAME,
            tweet_id[0:4],
            (tweet_id + '.json'),
        )
        return path.resolve()
    
    def _is_tweet_processed(self, tweet: TweetJSON) -> bool:
        '''
        Check if tweet has been fetched from the API, previously attempted to
        be fetched, or loaded from disk. Determining this is archive-specific,
        as older archive types included user info, whereas newer ones do not.
        '''
        # Loaded from disk means processed, no question
        if tweet.saved_at is not None:
            return True
        # Unset contents (as opposed to an empty dict) means unproccesed
        if tweet.contents is None:
            return False
        # Here we're doing a bit of heuristic: if the user sub-object is set,
        # then either it was successfully retrieved from the API, or it was
        # deleted Twitter-side, and we're storing an incomplete version because
        # it's all that we have access to in some fashion
        if 'user' in tweet.contents:
            return True
        # Otherwise, not yet processed
        return False
    
    def _load_tweet_json(self, tweet: TweetJSON) -> TweetJSON:
        # Look for file, load file, parse JSON
        tweet_path = self._get_tweet_save_path(tweet.id_str)
        try:
            with tweet_path.open('r') as f:
                tweet.contents = json.load(f)
        except FileNotFoundError:
            # If not found, tweet.saved_at will remain None, and that will be
            # our indicator of failure
            pass
        else:
            # Set (and possibly overwrite) path to match loaded contents
            tweet.saved_at = tweet_path

        return tweet
    
    def _save_tweet_json(self, tweet: TweetJSON) -> TweetJSON:
        if tweet.contents is None:
            raise ValueError(f'Cannot save empty tweet {tweet.id}')

        # Ensure required parent directories created, then dump as JSON
        tweet_path = self._get_tweet_save_path(tweet.id_str)
        tweet_path.parent.mkdir(parents=True, exist_ok=True)
        with tweet_path.open('w') as f:
            json.dump(tweet.contents, f, indent=2)
        # Set (and possibly overwrite) path to match saved contents
        tweet.saved_at = tweet_path

        return tweet
    
    def _fetch_tweet_json(self, tweet: TweetJSON, api: tweepy.API) -> TweetJSON:
        try:
            # Fetch with full information if possible
            t = api.get_status(
                tweet.id_str,
                include_ext_alt_text=True,
                tweet_mode='extended',
            )
        except tweepy.errors.NotFound:
            # Assuming we're fetching a once-valid tweet ID, most likely the
            # tweet has been deleted since - if we have some information, keep
            # it, and if not, add a very basic skeleton to indicate we've seen
            # this tweet and we can't expand it
            if tweet.contents is None:
                tweet.contents = {
                    'id': tweet.id,
                    'id_str': tweet.id_str,
                }
            if 'user' not in tweet.contents:
                tweet.contents['user'] = {
                    'id': int(self.user_id),
                    'id_str': self.user_id,
                }
        else:
            # Otherwise, if fetch was successful, store (a copy of) the result
            tweet.contents = json.loads(json.dumps(t._json))

        return tweet
    
    def load_tweets(self) -> None:
        '''
        Load tweets from tweet_file, sort by id, and load any tweets already
        fetched by a previous processing run.
        '''
        raise NotImplementedError
