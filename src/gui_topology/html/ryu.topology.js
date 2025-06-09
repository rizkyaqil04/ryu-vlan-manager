var CONF = {
    image: {
        width: 50,
        height: 40
    },
    force: {
        width: 790,
        height: 500,
        dist: 200,
        charge: -600
    }
};

var ws = new WebSocket("ws://" + location.host + "/v1.0/topology/ws");
ws.onmessage = function(event) {
    var data = JSON.parse(event.data);

    var result = rpc[data.method](data.params);

    var ret = {"id": data.id, "jsonrpc": "2.0", "result": result};
    this.send(JSON.stringify(ret));
}

function trim_zero(obj) {
    return String(obj).replace(/^0+/, "");
}

function dpid_to_int(dpid) {
    return Number("0x" + dpid);
}

var elem = {
    force: d3.layout.force()
        .size([CONF.force.width, CONF.force.height])
        .charge(CONF.force.charge)
        .linkDistance(CONF.force.dist)
        .on("tick", _tick),
    svg: d3.select("#topology-container").append("svg")
        .attr("id", "topology")
        .attr("width", CONF.force.width)
        .attr("height", CONF.force.height),
    console: d3.select("body").append("div")
        .attr("id", "console")
        .attr("width", CONF.force.width)
};
function _tick() {
    elem.link.attr("x1", function(d) { return d.source.x; })
        .attr("y1", function(d) { return d.source.y; })
        .attr("x2", function(d) { return d.target.x; })
        .attr("y2", function(d) { return d.target.y; });

    elem.node.attr("transform", function(d) { return "translate(" + d.x + "," + d.y + ")"; });

    elem.port.attr("transform", function(d) {
        var p = topo.get_port_point(d);
        return "translate(" + p.x + "," + p.y + ")";
    });
}
elem.drag = elem.force.drag().on("dragstart", _dragstart);
function _dragstart(d) {
    var dpid = dpid_to_int(d.dpid);

    // Fetch flow entries for the selected switch
    d3.json("/stats/flow/" + dpid, function(e, data) {
        var flows = data[dpid];
        // Show DPID info
        var switchInfoDiv = document.getElementById("switch-info");
        switchInfoDiv.innerHTML = "<b>DPID:</b> " + trim_zero(d.dpid);

        // Show flow entries in a separate table
        var flowDiv = document.getElementById("flow-entries");
        if (!flowDiv) {
            // Create the div if it doesn't exist
            flowDiv = document.createElement("div");
            flowDiv.id = "flow-entries";
            switchInfoDiv.parentNode.appendChild(flowDiv);
        }
        if (!flows || flows.length === 0) {
            flowDiv.innerHTML = "<h3>Flow Entries</h3><p>No flow entries found.</p>";
            return;
        }

        // Build table with more columns
        var table = `<h3>Flow Entries</h3>
        <div class="flow-table-wrapper">
        <table class="flow-table" border="0" cellpadding="6" style="border-collapse:collapse; width:100%; background:#f7fafd; border-radius:8px; box-shadow:0 1px 4px rgba(44,62,80,0.05);">
        <thead>
        <tr style="background:#e3eafc;">
        <th>Cookie</th>
        <th>Duration (s)</th>
        <th>Table</th>
        <th>Packets</th>
        <th>Bytes</th>
        <th>Idle Timeout</th>
        <th>Hard Timeout</th>
        <th>Priority</th>
        <th>Match</th>
        <th>Actions</th>
        </tr>
        </thead>
        <tbody>`;

        flows.forEach(function(flow) {
            table += "<tr>";
            table += "<td>" + (flow.cookie !== undefined ? flow.cookie : "") + "</td>";
            table += "<td>" + (flow.duration_sec !== undefined ? flow.duration_sec : "") + "</td>";
            table += "<td>" + (flow.table_id !== undefined ? flow.table_id : "") + "</td>";
            table += "<td>" + (flow.packet_count !== undefined ? flow.packet_count : "") + "</td>";
            table += "<td>" + (flow.byte_count !== undefined ? flow.byte_count : "") + "</td>";
            table += "<td>" + (flow.idle_timeout !== undefined ? flow.idle_timeout : "") + "</td>";
            table += "<td>" + (flow.hard_timeout !== undefined ? flow.hard_timeout : "") + "</td>";
            table += "<td>" + (flow.priority !== undefined ? flow.priority : "") + "</td>";
            table += "<td class='match'><pre style='white-space:pre-wrap;'>" + JSON.stringify(flow.match, null, 1) + "</pre></td>";
            table += "<td class='actions'><pre style='white-space:pre-wrap;'>" + JSON.stringify(flow.actions || flow.instructions, null, 1) + "</pre></td>";
            table += "</tr>";
        });
        table += "</tbody></table></div>";
        flowDiv.innerHTML = table;
    });

    d3.select(this).classed("fixed", d.fixed = true);
}
elem.node = elem.svg.selectAll(".node");
elem.link = elem.svg.selectAll(".link");
elem.port = elem.svg.selectAll(".port");
elem.update = function () {
    this.force
        .nodes(topo.nodes)
        .links(topo.links)
        .start();

    this.link = this.link.data(topo.links);
    this.link.exit().remove();
    this.link.enter().append("line")
        .attr("class", "link");

    this.node = this.node.data(topo.nodes);
    this.node.exit().remove();
    var nodeEnter = this.node.enter().append("g")
        .attr("class", function(d) { return d.isHost ? "node host" : "node"; })
        .on("dblclick", function(d) { d3.select(this).classed("fixed", d.fixed = false); })
        .call(this.drag);

    nodeEnter.append("image")
        .attr("xlink:href", function(d) { return d.isHost ? "./host.svg" : "./router.svg"; })
        .attr("x", -CONF.image.width/2)
        .attr("y", -CONF.image.height/2)
        .attr("width", CONF.image.width)
        .attr("height", CONF.image.height);

    nodeEnter.append("text")
        .attr("dx", -CONF.image.width/2)
        .attr("dy", CONF.image.height-10)
        .text(function(d) { 
            return d.isHost ? d.mac : "dpid: " + trim_zero(d.dpid); 
        });

    var ports = topo.get_ports();
    this.port.remove();
    this.port = this.svg.selectAll(".port").data(ports);
    var portEnter = this.port.enter().append("g")
        .attr("class", "port");
    portEnter.append("circle")
        .attr("r", 8);
    portEnter.append("text")
        .attr("dx", -3)
        .attr("dy", 3)
        .text(function(d) { return trim_zero(d.port_no); });
};

function is_valid_link(link) {
    return (link.src.dpid < link.dst.dpid)
}

var topo = {
    nodes: [],
    links: [],
    node_index: {}, // dpid -> index of nodes array
    initialize: function (data) {
        this.add_nodes(data.switches);
        this.add_links(data.links);
        if (data.hosts) this.add_hosts(data.hosts); // Add hosts if present
    },
    add_nodes: function (nodes) {
        for (var i = 0; i < nodes.length; i++) {
            this.nodes.push(nodes[i]);
        }
        this.refresh_node_index();
    },
    add_links: function (links) {
        for (var i = 0; i < links.length; i++) {
            if (!is_valid_link(links[i])) continue;
            console.log("add link: " + JSON.stringify(links[i]));

            var src_dpid = links[i].src.dpid;
            var dst_dpid = links[i].dst.dpid;
            var src_index = this.node_index[src_dpid];
            var dst_index = this.node_index[dst_dpid];
            var link = {
                source: src_index,
                target: dst_index,
                port: {
                    src: links[i].src,
                    dst: links[i].dst
                }
            }
            this.links.push(link);
        }
    },
    add_hosts: function(hosts) {
        for (var i = 0; i < hosts.length; i++) {
            var host = hosts[i];
            var hostNode = {
                dpid: host.mac, // use MAC as unique id
                mac: host.mac,
                ipv4: host.ipv4,
                isHost: true
            };
            this.nodes.push(hostNode);
            this.refresh_node_index();

            // Create link from host to switch if port info is complete
            if (
                host.port &&
                typeof host.port.dpid !== "undefined" &&
                typeof host.port.port_no !== "undefined"
            ) {
                var swIdx = this.node_index[host.port.dpid];
                var hostIdx = this.node_index[host.mac];
                this.links.push({
                    source: hostIdx,
                    target: swIdx,
                    port: { 
                        src: { dpid: host.mac, port_no: 1 }, // dummy port_no for host
                        dst: { dpid: host.port.dpid, port_no: host.port.port_no }
                    },
                    isHostLink: true
                });
            }
        }
    },
    delete_nodes: function (nodes) {
        for (var i = 0; i < nodes.length; i++) {
            console.log("delete switch: " + JSON.stringify(nodes[i]));

            var node_index = this.get_node_index(nodes[i]);
            this.nodes.splice(node_index, 1);
        }
        this.refresh_node_index();
    },
    delete_links: function (links) {
        for (var i = 0; i < links.length; i++) {
            if (!is_valid_link(links[i])) continue;
            console.log("delete link: " + JSON.stringify(links[i]));

            var link_index = this.get_link_index(links[i]);
            this.links.splice(link_index, 1);
        }
    },
    get_node_index: function (node) {
        for (var i = 0; i < this.nodes.length; i++) {
            if (node.dpid == this.nodes[i].dpid) {
                return i;
            }
        }
        return null;
    },
    get_link_index: function (link) {
        for (var i = 0; i < this.links.length; i++) {
            if (link.src.dpid == this.links[i].port.src.dpid &&
                    link.src.port_no == this.links[i].port.src.port_no &&
                    link.dst.dpid == this.links[i].port.dst.dpid &&
                    link.dst.port_no == this.links[i].port.dst.port_no) {
                return i;
            }
        }
        return null;
    },
    get_ports: function () {
        var ports = [];
        var pushed = {};
        for (var i = 0; i < this.links.length; i++) {
            function _push(p, dir) {
                var key = p.dpid + ":" + p.port_no;
                if (key in pushed) {
                    return 0;
                }

                pushed[key] = true;
                p.link_idx = i;
                p.link_dir = dir;
                return ports.push(p);
            }
            _push(this.links[i].port.src, "source");
            _push(this.links[i].port.dst, "target");
        }

        return ports;
    },
    get_port_point: function (d) {
        var weight = 0.88;

        var link = this.links[d.link_idx];
        var x1 = link.source.x;
        var y1 = link.source.y;
        var x2 = link.target.x;
        var y2 = link.target.y;

        if (d.link_dir == "target") weight = 1.0 - weight;

        var x = x1 * weight + x2 * (1.0 - weight);
        var y = y1 * weight + y2 * (1.0 - weight);

        return {x: x, y: y};
    },
    refresh_node_index: function(){
        this.node_index = {};
        for (var i = 0; i < this.nodes.length; i++) {
            this.node_index[this.nodes[i].dpid] = i;
        }
    },
}

var rpc = {
    event_switch_enter: function (params) {
        var switches = [];
        for(var i=0; i < params.length; i++){
            switches.push({"dpid":params[i].dpid,"ports":params[i].ports});
        }
        topo.add_nodes(switches);
        elem.update();
        return "";
    },
    event_switch_leave: function (params) {
        var switches = [];
        for(var i=0; i < params.length; i++){
            switches.push({"dpid":params[i].dpid,"ports":params[i].ports});
        }
        topo.delete_nodes(switches);
        elem.update();
        return "";
    },
    event_link_add: function (links) {
        topo.add_links(links);
        elem.update();
        return "";
    },
    event_link_delete: function (links) {
        topo.delete_links(links);
        elem.update();
        return "";
    },
}

function initialize_topology() {
    d3.json("/v1.0/topology/switches", function(error, switches) {
        d3.json("/v1.0/topology/links", function(error, links) {
            // Get host data
            d3.json("/v1.0/topology/hosts", function(error, hosts) {
                topo.initialize({switches: switches, links: links, hosts: hosts});
                elem.update();
            });
        });
    });
}

// Helper: fetch JSON
function fetchJSON(url, cb) {
    var xhr = new XMLHttpRequest();
    xhr.open("GET", url, true);
    xhr.onreadystatechange = function() {
        if (xhr.readyState === 4 && xhr.status === 200) {
            cb(JSON.parse(xhr.responseText));
        }
    };
    xhr.send();
}

// Populate DPID dropdown
function populateDPIDDropdown() {
    fetchJSON("/v1.0/topology/switches", function(switches) {
        var dropdown = document.getElementById("dpid-dropdown");
        dropdown.innerHTML = "";
        switches.forEach(function(sw) {
            var opt = document.createElement("option");
            opt.value = sw.dpid;
            opt.text = "dpid: " + parseInt(sw.dpid, 16);
            dropdown.appendChild(opt);
        });
        if (switches.length > 0) {
            renderPortForm(switches[0].dpid);
        }
        dropdown.onchange = function() {
            renderPortForm(dropdown.value);
        };
    });
}

function renderPortForm(dpid) {
    var tbody = document.querySelector("#port-form-table tbody");
    if (!tbody) return;

    tbody.innerHTML = ""; // Clear all tbody content (including button and previous port rows)

    fetchJSON("/v1.0/topology/switches", function(switches) {
        var sw = switches.find(s => s.dpid == dpid);
        if (!sw) return;

        var dpidDec = parseInt(dpid, 16);

        fetchJSON("/vlan/" + dpidDec + "/access", function(access) {
            fetchJSON("/vlan/" + dpidDec + "/trunk", function(trunk) {
                sw.ports.forEach(function(port) {
                    if (port.port_no === "LOCAL") return;

                    var portStr = String(port.port_no);
                    var tr = document.createElement("tr");

                    // Port column
                    var tdPort = document.createElement("td");
                    tdPort.textContent = portStr;
                    tr.appendChild(tdPort);

                    // Type column (Access/Trunk)
                    var tdType = document.createElement("td");
                    var sel = document.createElement("select");
                    sel.innerHTML = "<option value='access'>Access</option><option value='trunk'>Trunk</option>";
                    if (access[portStr]) sel.value = "access";
                    else if (trunk[portStr]) sel.value = "trunk";
                    tdType.appendChild(sel);
                    tr.appendChild(tdType);

                    // VLAN ID column
                    var tdVlan = document.createElement("td");
                    var inp = document.createElement("input");
                    inp.type = "text";
                    inp.size = 8;
                    inp.placeholder = "e.g. 10,20";
                    if (access[portStr]) inp.value = access[portStr];
                    else if (trunk[portStr]) inp.value = trunk[portStr].join(",");
                    tdVlan.appendChild(inp);
                    tr.appendChild(tdVlan);

                    // Assign column (Checkbox)
                    var tdCheck = document.createElement("td");
                    var cb = document.createElement("input");
                    cb.type = "checkbox";
                    tdCheck.appendChild(cb);
                    tr.appendChild(tdCheck);

                    tbody.appendChild(tr);
                });

                // Add "Assign All Checked" button row (only once)
                var trBtn = document.createElement("tr");
                var tdBtn = document.createElement("td");
                tdBtn.colSpan = 4;

                var btn = document.createElement("button");
                btn.type = "button";
                btn.textContent = "Assign All Checked";

                btn.onclick = function() {
                    var trs = tbody.querySelectorAll("tr");
                    var tasks = [];

                    trs.forEach(function(tr) {
                        var tds = tr.getElementsByTagName("td");
                        if (tds.length < 4) return;

                        var port = tds[0].textContent.trim();
                        var type = tds[1].querySelector("select").value;
                        var vlanInput = tds[2].querySelector("input").value;
                        var checked = tds[3].querySelector("input").checked;

                        if (!checked || !vlanInput.trim()) return;

                        var vlanIds = vlanInput.split(",").map(s => s.trim()).filter(Boolean);
                        if (!vlanIds.length) return;

                        if (type === "trunk") {
                            vlanIds.forEach(function(vlan_id) {
                                tasks.push([dpid, port, vlan_id, "trunk"]);
                            });
                        } else {
                            tasks.push([dpid, port, vlanIds[0], "access"]);
                        }
                    });

                    var remaining = tasks.length;
                    if (!remaining) return;

                    tasks.forEach(function(t) {
                        assignVLAN(...t, function(success, res) {
                            remaining--;
                            if (remaining === 0) {
                                renderPortForm(dpid);
                                renderVlanTable();
                            }
                        });
                    });
                };

                tdBtn.appendChild(btn);
                trBtn.appendChild(tdBtn);
                tbody.appendChild(trBtn);
            });
        });
    });
}

// Assign VLAN via REST
function assignVLAN(dpid, port, vlan_id, type, callback) {
    var url = "/vlan/" + parseInt(dpid, 16) + "/" + type;
    var data = JSON.stringify({port: parseInt(port), vlan_id: parseInt(vlan_id)});
    var xhr = new XMLHttpRequest();
    xhr.open("POST", url, true);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.onreadystatechange = function() {
        if (xhr.readyState === 4) {
            if (callback) callback(xhr.status === 200, xhr.responseText);
        }
    };
    xhr.send(data);
}

// Render VLAN assignment table
function renderVlanTable() {
    fetchJSON("/v1.0/topology/switches", function(switches) {
        let entries = [];
        let done = 0;

        switches.forEach(function(sw) {
            let dpid = parseInt(sw.dpid, 16);

            fetchJSON("/vlan/" + dpid + "/access", function(access) {
                Object.entries(access).forEach(([port, vlan]) => {
                    entries.push({ dpid, port: parseInt(port), type: "access", vlan: String(vlan) });
                });
                checkDone();
            });

            fetchJSON("/vlan/" + dpid + "/trunk", function(trunk) {
                Object.entries(trunk).forEach(([port, vlanList]) => {
                    entries.push({ dpid, port: parseInt(port), type: "trunk", vlan: vlanList.join(",") });
                });
                checkDone();
            });
        });

        function checkDone() {
            done++;
            if (done === switches.length * 2) {
                entries.sort((a, b) => {
                    if (a.dpid !== b.dpid) return a.dpid - b.dpid;
                    return a.port - b.port;
                });

                const tbody = document.querySelector("#vlan-table tbody");
                tbody.innerHTML = "";

                entries.forEach(({ dpid, port, type, vlan }) => {
                    const tr = document.createElement("tr");
                    tr.innerHTML = `<td>${dpid}</td><td>${port}</td><td>${type}</td><td>${vlan}</td>`;
                    tbody.appendChild(tr);
                });
            }
        }
    });
}

// Main function
function main() {
    initialize_topology();
    populateDPIDDropdown();
    renderVlanTable();
}

// Run main function
main();