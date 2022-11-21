#!/usr/bin/env python3

import json
import os
import sys
from pathlib import Path
from typing import Optional, Union, Iterable, Sequence

import tweepy


class InvalidCredentials(Exception):
    pass

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
    consumer_file = base_dir.joinpath('consumer.json')
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
    access_file = base_dir.joinpath('access.json')
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
