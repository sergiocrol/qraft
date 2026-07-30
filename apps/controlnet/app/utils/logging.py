import logging
import os
import sys


def get_logger(name):
    logger = logging.getLogger(name)

    if logger.handlers:
        return logger

    root = logging.getLogger()
    if root.handlers:
        # Root already configured, use it.
        return logger

    log_level = os.environ.get('LOG_LEVEL', 'INFO')
    level = getattr(logging, log_level.upper(), logging.INFO)
    logger.setLevel(level)

    handler = logging.StreamHandler(sys.stdout)
    formatter = logging.Formatter(
        '%(asctime)s - %(name)s - %(levelname)s - %(message)s'
    )
    handler.setFormatter(formatter)
    logger.addHandler(handler)

    return logger