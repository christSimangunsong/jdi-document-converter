import os
import sys

os.environ["PATH"] = (
    r"C:\Users\ACER\.conda\envs\jdi-ocr\Library\bin;" + os.environ.get("PATH", "")
)
os.environ["TESSDATA_PREFIX"] = r"C:\Users\ACER\.conda\envs\jdi-ocr\share\tessdata"

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import uvicorn

port = int(os.environ.get("DESKEW_PORT", "5002"))
uvicorn.run("deskew:app", host="127.0.0.1", port=port, log_level="warning")
