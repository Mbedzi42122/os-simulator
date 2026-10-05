from flask import Blueprint, jsonify

system_bp = Blueprint("system", __name__)

DEFAULT_CONFIG = {"memorySize": 32, "pageSize": 4, "virtualMemorySize": 128,
                  "replacementAlgorithm": "FIFO", "pageFaultTime": 2, "diskSize": 200,
                  "schedulingAlgorithm": "FCFS", "timeQuantum": 4}


@system_bp.get("/health")
def health():
    return jsonify(status="ok")


@system_bp.get("/config/defaults")
def defaults():
    return jsonify(DEFAULT_CONFIG)
