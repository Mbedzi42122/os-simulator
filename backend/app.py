"""Flask backend. Serves the frontend and exposes minimal APIs.

Simulation logic currently lives entirely in the browser; the backend is
the integration point for future server-side features.
"""
from pathlib import Path
from flask import Flask, jsonify, send_from_directory
from routes.system_routes import system_bp

FRONTEND = Path(__file__).resolve().parent.parent / "frontend"
app = Flask(__name__, static_folder=None)
app.register_blueprint(system_bp, url_prefix="/api")


@app.get("/")
def index():
    return send_from_directory(FRONTEND, "index.html")


@app.get("/<path:path>")
def static_files(path):
    return send_from_directory(FRONTEND, path)


@app.errorhandler(404)
def not_found(_):
    return jsonify(error="Not found"), 404


if __name__ == "__main__":
    app.run(debug=True, port=5000)
