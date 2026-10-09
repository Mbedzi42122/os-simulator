# Web-Based Operating System Simulator

Educational, interactive simulation of OS concepts. Nothing here touches a real CPU, RAM or disk — everything is data structures and algorithms.

## Status: Phases 1–6, RAID and Visualization complete
| Phase | Module | State |
|---|---|---|
| 1 | Project foundation (layout, Flask server, UI shell, navigation) | done |
| 2 | **Module 0 – Simulation engine** (state, clock, start/pause/resume/step/reset, speed, event bus) | done |
| 3 | **Module 1 – Process management** (create, validate, states, transitions, terminate, remove, table, search) | done |
| 4 | **CPU + scheduling** (uniprocessor: FCFS, SJF, Priority, Round Robin, Gantt chart, statistics) | done |
| 5 | **Memory management** (paging: frames, page tables, address translation) | done |
| 6 | **Virtual memory** (demand paging, page faults, FIFO/LRU/Optimal replacement, replacement lab) | done |
| 12 | **RAID simulation + failure simulation** (levels 0-6, 10, 50, 60; backing store of virtual memory) | done |
| 13 | **Visualization** (animated CPU / page table / main memory / secondary memory, page faults and replacement) | done |

Sidebar entries marked "soon" are placeholders for later phases; they perform no fake actions.

## Run
Frontend only (ES modules need HTTP, not `file://`):
```
cd frontend && python3 -m http.server 8000     # open http://localhost:8000
```
With Flask:
```
cd backend && pip install -r requirements.txt && python app.py    # http://localhost:5000
```

## Tests (Node 18+)
```
npm test
```
94 tests cover the engine, processes, scheduling, paging, demand paging, page replacement, RAID and the visualization logic.

## Architecture
- `SimulationState.js` – single source of truth (clock, status, speed, processes, events, config).
- `SimulationEngine.js` – owns state, clock, event bus and a timer. Modules register `{onTick, onReset}` and are updated in order each tick. `reset()` mutates the state in place so modules never hold stale references.
- `EventBus.js` – pub/sub; `'*'` subscribes to everything. All events are appended to `state.events` (the event log).
- `ProcessManager.js` – all process rules; UI only calls its methods.

### Process rules
States: NEW, READY, RUNNING, WAITING, SUSPENDED, TERMINATED. Allowed transitions are in `Process.js` (`TRANSITIONS`); anything else throws `InvalidTransitionError`.
**Priority: lower number = higher priority (0–10).** NEW processes become READY when the clock reaches their arrival time (and READY processes accrue waiting time each tick). PIDs are `P001`, `P002`, … and restart after Reset.

### Adding a module later
Create a class with `onTick`/`onReset`, call `engine.registerModule(...)`, publish events via `engine.log(type, message)`, and add a view in `app.js`.

## Scheduling (Phase 4)
- **Uniprocessor:** there is exactly one CPU (`state.cpu`); there is no CPU-count setting.
- **Time model:** tick N simulates the slot [N-1, N]. Each tick: wake processes whose page fault has been served → dispatch if the CPU is idle → count waiting → run one unit → handle completion/preemption.
- FCFS, SJF (non-preemptive, shortest remaining time), Priority (non-preemptive, lower number = higher priority), Round Robin (configurable quantum, preemptive). Ties go to the process that became READY first.
- Add an algorithm by adding an entry to `ALGORITHMS` in `cpu/Scheduler.js` (`select(queue, get)` returns a PID).
- Statistics: waiting, turnaround, response, completion, averages, throughput (completed/clock) and CPU utilisation.
- Manual state changes made in the Processes page are reconciled with the CPU on the next tick.
- "Load demo processes" lives on the Processes page.

## Memory and virtual memory (Phases 5-6, integrated)
Memory and virtual memory are one system built on **paging**. Sizes are in KB.
- **Memory (`MemoryManager`)**: physical memory (default 32 KB) is divided into frames of `pageSize` KB (default 4 KB -> 8 frames). Every process is divided into pages of the same size (`ceil(memoryRequired / pageSize)`). Each process has a page table (page -> frame, or "not in memory"). Pages can sit in any frame, so there is no external fragmentation; the unused tail of a process's last page is **internal fragmentation**. Translation: page = ⌊addr ÷ page size⌋, offset = addr mod page size, physical = frame × page size + offset.
- **Virtual memory (`VirtualMemory`)**: the backing store (default 128 KB) bounds the total address space of all live processes, so a process may be larger than physical memory. A process gets its page table when it is created and can become READY only if its pages fit in the backing store (otherwise it waits in NEW). No page is loaded up front: **demand paging**.
- **How they work together at run time:** each instruction a RUNNING process executes references one page (deterministic reference stream with locality). If the page is in a frame it is a hit. Otherwise it is a **page fault**: the page is loaded into the lowest free frame, or - if memory is full - into the frame of a victim chosen by the replacement algorithm (FIFO, LRU or Optimal, global scope). The faulting process moves to WAITING for `pageFaultTime` ticks (the CPU runs someone else), then becomes READY and retries the same reference. When a process terminates its frames and page table are freed.
- **Page replacement lab (live):** no controls of its own. It replays the **last 100 page references** recorded by your running processes through FIFO, LRU and Optimal, using the system's real **number of frames** (RAM / page size) and the **replacement algorithm** selected in the memory settings, and recomputes on every tick of the simulation clock (frames-over-time table, fault/hit counts, comparison of the three algorithms, and what the real system did in the same window). Change the frames or the algorithm on the Memory / Demand paging pages or in Settings and the lab follows.

## RAID (Module 12 + RAID failure simulation)
The **RAID page** simulates a disk array and is wired into the rest of the system: **the array is the backing store of virtual memory.**

**Configuration:** RAID level (0, 1, 5, 6, 10, 50, 60), number of disks (2-16) and disk capacity in blocks (1-32). One block = one page (`pageSize` KB). Counts that a level cannot use are rejected with a reason (RAID 5 needs 3+, RAID 6 needs 4+, RAID 10 needs an even number, RAID 50/60 need equal sub-arrays of 3+/4+ disks, RAID 2 cannot use a power-of-two count because its Hamming parity disks sit at positions 1, 2, 4, 8...).

**Visualisation:** every disk is a column of blocks (`A1, A2...`); data, parity `P`, second parity `Q`, and mirror copies have different colours; RAID 10/50/60 show their groups above the disks. Each block shows a stored byte and, if a process page lives there, the owning PID and page.

**Layouts:** RAID 0 striping; RAID 1 full mirrors; RAID 5 block striping with the parity block rotating across the disks; RAID 6 block striping with two rotating parity blocks (P = XOR, Q = Reed-Solomon); RAID 10 striped mirror pairs; RAID 50 striped RAID 5 sub-arrays; RAID 60 striped RAID 6 sub-arrays. RAID 2, 3 and 4 were removed.

**Failure simulation (nothing is predefined text):** the array is modelled as *groups* (single disk, mirror set, parity group, P+Q group), each with a tolerance. Pressing *Fail disk* marks the disk failed and wipes its contents; the status is derived from the failed set:
- `OPTIMAL` - no disk down. `DEGRADED` - disks down but every group is within its tolerance. `FAILED` - some group lost more disks than it tolerates (the array is offline and data is lost for good).
- Location matters: RAID 10 survives disks 1+4 but not 1+2; RAID 50 survives one failure per sub-array; RAID 60 two per sub-array.
- The page shows the group table, the next failures that would destroy the array, how many blocks are read directly / rebuilt on the fly / unreadable, and a **reconstruction check** that recomputes every missing block from the survivors (mirror copy, XOR, Reed-Solomon over GF(2^8) for Q, Hamming equations) and compares it with the original content.
- The comparison table of levels was removed from the RAID page.

**Replace and rebuild:** *Replace* inserts a blank disk; it is rebuilt one row per simulation tick (so Start/Step the clock, or press *Complete rebuild now*). The recomputed contents are verified against the original. A FAILED array cannot be rebuilt: *Re-create array* formats it again and every block that was stored is lost.

**How it links to the other modules**
- *Virtual memory / memory:* the array's usable blocks bound the address space (`min(virtualMemorySize, usable)`); a process gets one logical block per page when it is admitted (first free blocks, released when it terminates). Each page fault performs a real read of that block.
- *Page-fault service time:* healthy read = `pageFaultTime` ticks. If the block is on a failed disk it is rebuilt from the surviving blocks of its stripe; every extra block read beyond a normal access adds one tick (RAID 5 with 5 disks: +3; RAID 1/10: mirror copy, +0; RAID 3/2: parity replaces the missing slice, +0).
- *Scheduler / processes:* the faulting process stays WAITING for the longer service time while the CPU runs someone else. If the block cannot be read (array FAILED, or block lost on re-creation) the process is **aborted** (`abortReason`, shown in the process detail) and its frames and blocks are freed. Processes whose pages are all resident keep running. New processes stay NEW while the array is offline.
- *Event log, dashboard, Virtual Memory page:* disk failures, rebuilds, reconstructed reads and aborts are logged; the dashboard and the Virtual Memory page show the array status and page-in statistics; the page-reference table shows which disk served each fault.
- The array can only be reconfigured while healthy and if the existing backing-store blocks still fit.

## Visualization (Module 13)
The **Visualization** page shows how a process, virtual memory, the page table, main memory and the CPU interact, and animates pages moving between them. Press Start/Step at the top, or click any page in virtual memory and press **CPU requests this page** (works while the simulation is stopped).

**Components (all live, read from the simulation state)**
- **CPU:** state, current process, instruction number (LOAD/STORE), page, frame and memory-access status (HIT / PAGE FAULT / waiting for disk / I/O ERROR).
- **Virtual address → physical address:** the address splits into page number + offset, the page table supplies the frame, and the physical address is `frame x page size + offset`; each part lights up as it is used. Offsets are deterministic per instruction.
- **Page table** (of the process the CPU runs, or any process you choose): page, frame, present, location. Rows highlight while looked up and flash when they change.
- **Main memory:** every frame with its owner (colour = process), page, FREE/OCCUPIED, *modified* and *loading I/O* flags.
- **Secondary memory > Virtual memory:** every process with all its pages as chips: *on disk*, *in memory (frame n)*, *loading* (waiting to be loaded) or *evicted* (replaced, back on disk). Each chip also shows the RAID block and disk that stores it (warning = will be rebuilt from parity, cross = unreadable). Click a chip for the page details (process, number, size, location, frame, status, modified, load/last-use order, disk block).
- **Arrows** between the components light up in the direction of the movement.

**The animation of one access** is built from the real trace record of the core (`buildSteps`): CPU request, page-table lookup, then either *page present > frame > data to the CPU*, or **PAGE FAULT > (no free frame: victim selection table showing why, eviction token back to disk, write-back if modified) > read from disk > the page token flies from secondary memory into the frame > page table updated > CPU resumes**. If the backing store is unreadable the sequence stops with an I/O ERROR and nothing is loaded. The frame and page-table row keep showing the old state until the step that changes them has played.

**Controls:** animate every access / page faults only / off; animation speed 0.5x-4x; choose the page table to show; *Hold the clock while an animation plays* (the clock is paused between ticks, not the status) so the story stays in step with the simulation. If animations fall far behind they fast-forward.

**Core additions used by it:** each trace record now has `seq`, `instr`, `offset`, `write`, the victim-selection `candidates` and the backing-store read; frames have a **dirty** bit (about one instruction in four is a store; evicting a modified page is logged as `PAGE_WRITEBACK` and counted); `VirtualMemory.requestPage()` performs a manual access through the normal path without blocking the process; `engine.holdClock()/releaseClock()`.
Referenced bits are not modelled: the *loaded* and *last used* order numbers (what FIFO and LRU compare) are shown instead. **Optimal** also runs live: each process's page references come from a deterministic stream, so the simulator reads ahead in a copy of that stream (up to the process's remaining burst time) and evicts the page whose next use is farthest away, or that is never used again (ties → lowest frame). Distances are counted in the owning process's own references, so across processes this is an approximation of true global Optimal (which would also need to know future scheduling). The victim panel shows "used next / used in N refs / never used again" for every frame.

## Removed
Synchronisation, Deadlock (with Banker's algorithm), Real-Time and Process Migration are no longer part of the project.

## Next
Disk scheduling (FCFS, SSTF, SCAN, C-SCAN, LOOK, C-LOOK) is not built; the Storage entry was removed from the sidebar.

### Visualization follows the simulation clock
The visualization has **no speed setting of its own**: every step and every flying page token runs at the simulation speed (0.5x - 10x), and changing the speed mid-animation re-times it. **Pause** freezes the animation in progress (tokens stop mid-flight, the note says so), **Resume** continues exactly where it stopped, and **Step** while paused plays the frozen animation forward. **Reset** discards it. The simulation clock, status and speed are shown on the visualization bar and each access is stamped with its tick (`t=hh:mm:ss`). "Hold the simulation clock while an animation plays" still lets a story finish before the next tick; Resume re-applies that hold.


## Dashboard metrics, page transfers and the live lab
- **Dashboard:** live metrics in four groups. *CPU* (utilisation, average waiting / turnaround / response time of completed processes), *Memory* (page faults, hits, fault rate %, hit rate %, replacements, memory utilisation %), *Virtual memory* (pages in RAM, pages on secondary storage, page transfer count, replacement count) and *RAID* (read operations, write operations = modified pages written back, failed disks, recovery operations = blocks rebuilt on read + completed disk rebuilds, storage utilisation %, estimated performance %). *Estimated performance* is 100% when every block is read directly from a healthy disk; a block that must be rebuilt from parity counts as half speed and an unreadable block as zero.
- **How it stays live:** `js/metrics/Metrics.js` reads the counters of the single simulation state. The dashboard is redrawn on every `STATE_CHANGED` event of the EventBus, which the engine emits on each tick of the clock and on every event (page fault, disk failure ...). `metrics.onUpdate(fn)` subscribes any other view to the same stream. Every counter lives in the simulation state, so **Reset** sets them all back to zero (estimated performance returns to 100% because the array is healthy again).
- **Pages transferred (Virtual Memory page):** counts every page swapped in from secondary storage (each page fault that loads a page) plus every page swapped out (each victim evicted); a hit transfers nothing. The same figure is the dashboard's *Page transfer count*.
- **Process details:** the Parent PID row was removed from the details view of a process (the field itself still exists in the process model).
