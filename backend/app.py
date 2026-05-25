from flask import Flask, jsonify
import os
import socket

app = Flask(__name__)

APP_NAME = os.getenv("APP_NAME", "cloud-lab-app")
APP_MESSAGE = os.getenv("APP_MESSAGE", "Hello from local Kubernetes")


@app.route("/")
def index():
    return jsonify({
        "app": APP_NAME,
        "message": APP_MESSAGE,
        "hostname": socket.gethostname()
    })


@app.route("/health")
def health():
    return jsonify({
        "status": "ok"
    })


@app.route("/info")
def info():
    return jsonify({
        "runtime": "Python Flask",
        "environment": dict(os.environ),
        "hostname": socket.gethostname()
    })


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)
