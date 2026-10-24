"""Load python/curved/rigorous.py (read-only) by explicit path, under a private module name, so that
python/curved/certify.py can never shadow python/sphere/certify.py on sys.path."""
import importlib.util
import os
import sys

_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "curved", "rigorous.py")
_spec = importlib.util.spec_from_file_location("_polypack_curved_rigorous", _path)
rg = importlib.util.module_from_spec(_spec)
sys.modules["_polypack_curved_rigorous"] = rg
_old = sys.dont_write_bytecode
sys.dont_write_bytecode = True  # never write a __pycache__ into python/curved
try:
    _spec.loader.exec_module(rg)
finally:
    sys.dont_write_bytecode = _old
