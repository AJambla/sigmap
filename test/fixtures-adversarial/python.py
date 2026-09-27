# Adversarial: nested defaults, collection defaults, keyword-only markers.
def nested_default(a, b=g(1)):
    return a


def collection_default(a=[1, 2], b={'k': 'v'}):
    return a


def kwonly(a, *, b=2, **kw):
    return a


def string_delims(sep=")"):
    return sep
