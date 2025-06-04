import eventlet
eventlet.monkey_patch()

from ryu.base import app_manager
from ryu.controller import ofp_event
from ryu.controller.handler import MAIN_DISPATCHER, CONFIG_DISPATCHER, set_ev_cls
from ryu.lib.packet import packet, ethernet, vlan as vlan_pkt, lldp
from ryu.ofproto import ofproto_v1_3
from ryu.app.wsgi import WSGIApplication, ControllerBase, route
from webob import Response
import json
import logging
logging.basicConfig(level=logging.INFO)

vlan_manager_instance_name = 'vlan_manager_trunk_app'
REST_API_BASE = '/vlan'

class VlanManagerTrunk(app_manager.RyuApp):
    OFP_VERSIONS = [ofproto_v1_3.OFP_VERSION]
    _CONTEXTS = {'wsgi': WSGIApplication}

    def __init__(self, *args, **kwargs):
        super(VlanManagerTrunk, self).__init__(*args, **kwargs)
        self.mac_to_port = {}  # {dpid: {mac: (port, vlan_id)}}
        self.access_ports = {} # {dpid: {port: vlan_id}}
        self.trunk_ports = {}  # {dpid: {port: set([vlan_id, ...])}}
        wsgi = kwargs['wsgi']
        wsgi.register(VlanTrunkRestController, {vlan_manager_instance_name: self})

    @set_ev_cls(ofp_event.EventOFPStateChange, [MAIN_DISPATCHER, CONFIG_DISPATCHER])
    def state_change_handler(self, ev):
        datapath = ev.datapath
        if ev.state in [MAIN_DISPATCHER, CONFIG_DISPATCHER]:
            self.logger.info("Switch %s connected", datapath.id)
            self.install_table_miss_flow(datapath)

            # Assign all ports to VLAN 1 (except LOCAL port)
            ofproto = datapath.ofproto
            parser = datapath.ofproto_parser
            req = parser.OFPPortDescStatsRequest(datapath, 0)
            res = datapath.send_msg(req)
            # Note: send_msg is async, so you need to handle reply in a handler

    def install_table_miss_flow(self, datapath):
        parser = datapath.ofproto_parser
        ofproto = datapath.ofproto
        match = parser.OFPMatch()
        actions = [parser.OFPActionOutput(ofproto.OFPP_CONTROLLER, ofproto.OFPCML_NO_BUFFER)]
        inst = [parser.OFPInstructionActions(ofproto.OFPIT_APPLY_ACTIONS, actions)]
        datapath.send_msg(parser.OFPFlowMod(datapath=datapath, priority=0, match=match, instructions=inst))

    @set_ev_cls(ofp_event.EventOFPPacketIn, MAIN_DISPATCHER)
    def packet_in_handler(self, ev):
        msg = ev.msg
        datapath = msg.datapath
        dpid = datapath.id
        parser = datapath.ofproto_parser
        ofproto = datapath.ofproto
        in_port = msg.match['in_port']
        pkt = packet.Packet(msg.data)

        eth = pkt.get_protocol(ethernet.ethernet)
        vlan_hdr = pkt.get_protocol(vlan_pkt.vlan)
        pkt_lldp = pkt.get_protocol(lldp.lldp)
        if eth is None:
            return
        if pkt_lldp and (in_port not in self.trunk_ports.get(dpid, {})):
            return

        src = eth.src
        dst = eth.dst

        vlan_id = None
        access = self.access_ports.get(dpid, {})
        trunk = self.trunk_ports.get(dpid, {})
        if in_port in access:
            vlan_id = access[in_port]
        elif in_port in trunk:
            vlan_id = vlan_hdr.vid if vlan_hdr else None

        # Check if any VLAN has been assigned yet (enter VLAN-aware mode)
        vlan_mode_active = bool(access or trunk)
        if vlan_mode_active:
            if in_port in trunk and vlan_hdr is None:
                return
            if in_port in trunk and vlan_id not in trunk[in_port]:
                return
            if in_port in access and vlan_id != access[in_port]:
                return
            if pkt_lldp and in_port in access:
                return

        # Learning
        self.mac_to_port.setdefault(dpid, {})
        if vlan_id is not None or not vlan_mode_active:
            self.mac_to_port[dpid][src] = (in_port, vlan_id)

        # Forwarding decision
        dst_info = self.mac_to_port[dpid].get(dst)
        if dst_info and (not vlan_mode_active or dst_info[1] == vlan_id):
            out_port = dst_info[0]
            match = parser.OFPMatch(
                in_port=in_port,
                eth_dst=dst,
                vlan_vid=(0x1000 | vlan_id) if vlan_id is not None else 0
            )
            actions = []
            if in_port in access and out_port in trunk:
                actions += [parser.OFPActionPushVlan(0x8100), parser.OFPActionSetField(vlan_vid=(0x1000 | vlan_id))]
            elif in_port in trunk and out_port in access:
                actions += [parser.OFPActionPopVlan()]
            actions.append(parser.OFPActionOutput(out_port))
            inst = [parser.OFPInstructionActions(ofproto.OFPIT_APPLY_ACTIONS, actions)]
            datapath.send_msg(parser.OFPFlowMod(
                datapath=datapath,
                priority=100,
                match=match,
                instructions=inst,
                idle_timeout=30,
                hard_timeout=60
            ))
        else:
            out_port = ofproto.OFPP_FLOOD

        # PacketOut
        actions = []
        if out_port == ofproto.OFPP_FLOOD and vlan_mode_active and vlan_id is not None:
            flood_ports = []
            for p, v in access.items():
                if v == vlan_id and p != in_port:
                    flood_ports.append(p)
            for p, vset in trunk.items():
                if vlan_id in vset and p != in_port:
                    flood_ports.append(p)
            for p in flood_ports:
                if in_port in access and p in trunk:
                    actions += [parser.OFPActionPushVlan(0x8100),
                                parser.OFPActionSetField(vlan_vid=(0x1000 | vlan_id))]
                elif in_port in trunk and p in access:
                    actions.append(parser.OFPActionPopVlan())
                actions.append(parser.OFPActionOutput(p))
        else:
            if in_port in access and out_port in trunk:
                actions += [parser.OFPActionPushVlan(0x8100),
                            parser.OFPActionSetField(vlan_vid=(0x1000 | vlan_id))]
            elif in_port in trunk and out_port in access:
                actions.append(parser.OFPActionPopVlan())
            actions.append(parser.OFPActionOutput(out_port))

        data = None
        if msg.buffer_id == ofproto.OFP_NO_BUFFER:
            data = msg.data

        datapath.send_msg(parser.OFPPacketOut(
            datapath=datapath,
            buffer_id=msg.buffer_id,
            in_port=in_port,
            actions=actions,
            data=data
        ))

    @set_ev_cls(ofp_event.EventOFPPortDescStatsReply, MAIN_DISPATCHER)
    def port_desc_stats_reply_handler(self, ev):
        datapath = ev.msg.datapath
        dpid = datapath.id
        for p in ev.msg.body:
            if p.port_no < 0xffffff00:  # skip OFPP_LOCAL and reserved
                self.access_ports.setdefault(dpid, {})[p.port_no] = 1
                self.trunk_ports.setdefault(dpid, {}).pop(p.port_no, None)

class VlanTrunkRestController(ControllerBase):
    def __init__(self, req, link, data, **config):
        super(VlanTrunkRestController, self).__init__(req, link, data, **config)
        self.vlan_manager = data[vlan_manager_instance_name]

    @route('vlan', REST_API_BASE + '/{dpid}/access', methods=['POST'])
    def add_access_port(self, req, **kwargs):
        dpid = int(kwargs['dpid'])
        try:
            body = req.json if req.body else {}
            port = int(body['port'])
            vlan_id = int(body['vlan_id'])
        except Exception:
            return Response(status=400, text="Invalid input")
        self.vlan_manager.access_ports.setdefault(dpid, {})[port] = vlan_id
        self.vlan_manager.trunk_ports.setdefault(dpid, {}).pop(port, None)
        return Response(content_type='application/json', text=json.dumps({'result': 'ok'}))

    @route('vlan', REST_API_BASE + '/{dpid}/trunk', methods=['POST'])
    def add_trunk_port(self, req, **kwargs):
        dpid = int(kwargs['dpid'])
        try:
            body = req.json if req.body else {}
            port = int(body['port'])
            vlan_id = int(body['vlan_id'])
        except Exception:
            return Response(status=400, text="Invalid input")
        self.vlan_manager.trunk_ports.setdefault(dpid, {}).setdefault(port, set()).add(vlan_id)
        self.vlan_manager.access_ports.setdefault(dpid, {}).pop(port, None)
        return Response(content_type='application/json', text=json.dumps({'result': 'ok'}))

    @route('vlan', REST_API_BASE + '/{dpid}/access', methods=['GET'])
    def get_access_ports(self, req, **kwargs):
        dpid = int(kwargs['dpid'])
        return Response(content_type='application/json',
                        text=json.dumps(self.vlan_manager.access_ports.get(dpid, {})))

    @route('vlan', REST_API_BASE + '/{dpid}/trunk', methods=['GET'])
    def get_trunk_ports(self, req, **kwargs):
        dpid = int(kwargs['dpid'])
        trunk = self.vlan_manager.trunk_ports.get(dpid, {})
        trunk_json = {str(p): list(vlans) for p, vlans in trunk.items()}
        return Response(content_type='application/json', text=json.dumps(trunk_json))
