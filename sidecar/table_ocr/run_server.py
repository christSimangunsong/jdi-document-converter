import os
import sys

os.environ["PATH"] = (
    r"C:\Users\ACER\.conda\envs\jdi-ocr\Library\bin;" + os.environ.get("PATH", "")
)
os.environ["TESSDATA_PREFIX"] = r"C:\Users\ACER\.conda\envs\jdi-ocr\share\tessdata"

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import uvicorn

uvicorn.run("main:app", host="127.0.0.1", port=5003, log_level="warning")
