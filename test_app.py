import json
import os

class AdaptiveSwarm:
    def __init__(self, tasks_file=".memory/sessions/test_session/test_query/TASKS.json"):
        self.tasks_file = tasks_file
        self.tasks_data = self._load_tasks()

    def _load_tasks(self):
        if os.path.exists(self.tasks_file):
            with open(self.tasks_file, 'r') as f:
                return json.load(f)
        return {"tasks": []}

    def select_topology(self, manual_override=None):
        """
        Task 2.1: Planner Topology Metadata logic
        """
        if manual_override:
            return manual_override.lstrip("-").capitalize()

        # Logic: If task dependencies > 0 and files overlap, choose Hierarchical.
        # If dependencies = 0, choose Parallel.
        # For simplicity, we'll check the first task in this simulation.
        tasks = self.tasks_data.get("tasks", [])
        if not tasks:
            return "Serial"

        # Check for dependencies or file overlaps (simulated)
        has_dependencies = any(len(t.get("dependencies", [])) > 0 for t in tasks)
        
        # Simulated file overlap check
        all_files = []
        for t in tasks:
            all_files.extend(t.get("files", []))
        has_file_overlap = len(all_files) != len(set(all_files))

        if has_dependencies or has_file_overlap:
            return "Hierarchical"
        else:
            return "Parallel"

    def select_model_tier(self, task):
        """
        Intelligence Routing Logic from control-pane skill.
        """
        # Escalation Logic: 2+ failures -> Upgrade
        failure_count = task.get("failure_count", 0)
        
        # Initial tier determination
        task_type = task.get("type", "implementation")
        risk = task.get("risk", "medium")
        complexity = task.get("complexity", "medium")

        tier = "Pro" # Default
        if task_type in ["planning", "architecture", "diagnosis"] or risk == "high" or complexity == "high":
            tier = "Ultra"
        elif task_type in ["research", "discovery"] or (risk == "low" and complexity == "low"):
            tier = "Flash"

        # Apply Escalation
        if failure_count >= 2:
            if tier == "Flash":
                tier = "Pro"
            elif tier == "Pro":
                tier = "Ultra"
        
        return tier

    def execute_task(self, task):
        tier = self.select_model_tier(task)
        print(f"Executing task {task['id']} with {tier} tier (Failures: {task.get('failure_count', 0)})")
        
        # Simulate execution
        if task.get("simulate_failure"):
            task["failure_count"] = task.get("failure_count", 0) + 1
            return "Failure"
        return "Success"

    def run_swarm(self, topology):
        print(f"Starting swarm with {topology} topology...")
        if topology == "Parallel":
            return self._simulate_parallel_execution()
        elif topology == "Hierarchical":
            return self._simulate_hierarchical_execution()
        else:
            return self._simulate_serial_execution()

    def _simulate_parallel_execution(self, fail_at_step=None):
        print("Executing tasks in parallel branches...")
        # Task 3.1: Fallback Engine logic
        # Simulate a failure
        if fail_at_step == "audit_failure":
            print("Detected 3+ audit failures in parallel branch!")
            return self.trigger_fallback()
        return "Success"

    def _simulate_hierarchical_execution(self):
        print("Supervisor managing workers...")
        return "Success"

    def _simulate_serial_execution(self):
        print("Executing tasks sequentially...")
        return "Success"

    def trigger_fallback(self):
        """
        Task 3.1: Fallback Engine - Topology Collapse
        """
        print("TRIGGERING FALLBACK: Collapsing topology to Serial mode.")
        return self.run_swarm("Serial")

def test_manual_override():
    swarm = AdaptiveSwarm()
    assert swarm.select_topology(manual_override="--serial") == "Serial"
    assert swarm.select_topology(manual_override="--parallel") == "Parallel"
    print("test_manual_override passed!")

def test_topology_selection():
    # Mock TASKS.json for parallel
    parallel_tasks = {
        "tasks": [
            {"id": "1", "dependencies": [], "files": ["file1.py"]},
            {"id": "2", "dependencies": [], "files": ["file2.py"]}
        ]
    }
    with open(".memory/TASKS_test.json", "w") as f:
        json.dump(parallel_tasks, f)
    
    swarm = AdaptiveSwarm(tasks_file=".memory/TASKS_test.json")
    assert swarm.select_topology() == "Parallel"

    # Mock TASKS.json for hierarchical (overlap)
    hierarchical_tasks = {
        "tasks": [
            {"id": "1", "dependencies": [], "files": ["shared.py"]},
            {"id": "2", "dependencies": ["1"], "files": ["shared.py"]}
        ]
    }
    with open(".memory/TASKS_test.json", "w") as f:
        json.dump(hierarchical_tasks, f)
    
    swarm = AdaptiveSwarm(tasks_file=".memory/TASKS_test.json")
    assert swarm.select_topology() == "Hierarchical"
    print("test_topology_selection passed!")

def test_fallback_trigger():
    swarm = AdaptiveSwarm()
    result = swarm._simulate_parallel_execution(fail_at_step="audit_failure")
    assert result == "Success" # Should eventually succeed after fallback
    print("test_fallback_trigger passed!")

def test_intelligence_routing():
    swarm = AdaptiveSwarm()
    # Planning task -> Ultra
    task_ultra = {"id": "R1", "type": "planning"}
    assert swarm.select_model_tier(task_ultra) == "Ultra"
    
    # Research task -> Flash
    task_flash = {"id": "R2", "type": "research", "risk": "low", "complexity": "low"}
    assert swarm.select_model_tier(task_flash) == "Flash"
    
    # Implementation task -> Pro
    task_pro = {"id": "R3", "type": "implementation"}
    assert swarm.select_model_tier(task_pro) == "Pro"
    print("test_intelligence_routing passed!")

def test_model_escalation():
    swarm = AdaptiveSwarm()
    task = {"id": "E1", "type": "research", "risk": "low", "complexity": "low", "failure_count": 0, "simulate_failure": True}
    
    # Initial tier: Flash
    assert swarm.select_model_tier(task) == "Flash"
    
    # First failure
    swarm.execute_task(task)
    assert task["failure_count"] == 1
    assert swarm.select_model_tier(task) == "Flash" # Still Flash after 1 failure
    
    # Second failure
    swarm.execute_task(task)
    assert task["failure_count"] == 2
    assert swarm.select_model_tier(task) == "Pro" # Escalate to Pro after 2 failures
    
    # Third failure
    swarm.execute_task(task)
    assert task["failure_count"] == 3
    assert swarm.select_model_tier(task) == "Pro" # Remains Pro until further threshold if defined (here it just checks >= 2)
    print("test_model_escalation passed!")

if __name__ == "__main__":
    test_manual_override()
    test_topology_selection()
    test_fallback_trigger()
    test_intelligence_routing()
    test_model_escalation()
    # Cleanup
    if os.path.exists(".memory/TASKS_test.json"):
        os.remove(".memory/TASKS_test.json")

    if os.path.exists(".memory/sessions/test_session/test_query/TASKS_test.json"):
        os.remove(".memory/sessions/test_session/test_query/TASKS_test.json")
