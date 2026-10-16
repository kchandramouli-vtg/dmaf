# -*- coding: utf-8 -*-
"""
Created on Wed Sep 30 08:22:35 2020

@author: mljub
"""


import os
import xml.etree.ElementTree as ET
from xml.etree.ElementTree import Element, SubElement, Comment, tostring
from xml.etree import ElementTree
import xml.dom.minidom as minidom
import json
from web3 import Web3
import sys


def indent(elem, level=0):
    i = "\n" + level*"\t"
    if len(elem):
        if not elem.text or not elem.text.strip():
            elem.text = i + "\t"
        if not elem.tail or not elem.tail.strip():
            elem.tail = i
        for elem in elem:
            indent(elem, level+1)
        if not elem.tail or not elem.tail.strip():
            elem.tail = i
    else:
        if level and (not elem.tail or not elem.tail.strip()):
            elem.tail = i


def generateCELconytract(w3, contractId, contract_address):
    from artifacts import load_artifact  # DMAF: compiled artifact, not a stale ./Ethereum_Smart.json
    abi = load_artifact("Ethereum_Smart.sol", "Cel")["abi"]
    contr = w3.eth.contract(
        address=contract_address, abi=abi,
    )

    fileName = 'Sc2Cel.xml'
    root = ET.Element('cel-core:Contract')
    root.set("xmlns:cel-core", "urn:mpeg:mpeg21:cel:core:2015")
    root.set("xmlns:cel-ipre", "urn:mpeg:mpeg21:cel:ipre:2015")
    root.set("xmlns:cel-pane", "urn:mpeg:mpeg21:cel:pane:2015")
    root.set("xmlns:cel-rele", "urn:mpeg:mpeg21:cel:rele:2015")
    root.set("xmlns:dc", "http://purl.org/dc/elements/1.1/")
    root.set("xmlns:xsi", "http://www.w3.org/2001/XMLSchema-instance")
    root.set("xmlns:dii", "urn:mpeg:mpeg21:2002:01-DII-NS")
    root.set("xmlns:dsig", "http://www.w3.org/2000/09/xmldsig#")
    root.set("xmlns:rel-r", "urn:mpeg:mpeg21:2003:01-REL-R-NS")
    root.set("xmlns:rel-mx", "urn:mpeg:mpeg21:2003:01-REL-MX-NS")
    root.set("xsi:schemaLocation", """urn:mpeg:mpeg21:cel:core:2015 cel-core.xsd    urn:mpeg:mpeg21:cel:ipre:2015 cel-ipre.xsd urn:mpeg:mpeg21:cel:pane:2015 cel-pane.xsd   urn:mpeg:mpeg21:cel:rele:2015 cel-rele.xsd urn:mpeg:mpeg21:2003:01-REL-R-NS http://standards.iso.org/ittf/PubliclyAvailableStandards/MPEG-21_schema_files/rel-r/rel-sx.xsd  urn:mpeg:mpeg21:2003:01-REL-MX-NS http://standards.iso.org/ittf/PubliclyAvailableStandards/MPEG-21_schema_files/rel-r/rel-mx.xsd""")
    root.set("contractId", contractId)
    # DMAF: TextVersion and Metadata live in the MediaToken (constructor args);
    # the reference reverse() dropped them, so its own parser couldn't read the
    # result back (cel-core:TextVersion is required by models/Contract.parse).
    try:
        import re
        from artifacts import load_artifact
        token = w3.eth.contract(address=contr.functions.tokenContract().call(),
                                abi=load_artifact("Ethereum_Media_Token.sol", "MediaToken")["abi"])
        tv = ET.SubElement(root, "cel-core:TextVersion")
        tv.text = token.functions.getTextVersion().call()
        md = ET.SubElement(ET.SubElement(root, "cel-core:Metadata"), "cel-core:SimpleDC")
        for tag, value in re.findall(r"<dc:(\w+)>(.*?)</dc:\1>", token.functions.getMetadata().call(), re.S):
            ET.SubElement(md, "dc:" + tag).text = value
    except Exception as e:  # pragma: no cover - keep the reference output if the token can't be read
        print("reverse: MediaToken metadata not read:", e)
    new_data = contr.functions.getParties().call()
    for i in range(0, len(new_data)):
        if new_data[i] != '':
            m3 = ET.SubElement(root, "cel-core:Party")

            if new_data[i].find("id: ") != -1:
                data1 = new_data[i].split("id: ")
                data2 = data1[1].split()
                if (data2[0][-1] != ':') and (data2[0] != 'None'):
                    m3.set('id', data2[0])

            if new_data[i].find("party type: ") != -1:
                data1 = new_data[i].split("party type: ")
                m4 = ET.SubElement(m3, "cel-core:"+data1[1])

            if new_data[i].find("address: ") != -1:
                data1 = new_data[i].split("address: ")
                data2 = data1[1].split()
                if (data2[0][-1] != ':') and (data2[0] != 'None'):
                    m5 = ET.SubElement(m3, "cel-core:Address")
                    m5.text = data2[0]

            if new_data[i].find("party: name: ") != -1:
                data1 = new_data[i].split("party: name: ")
                data2 = data1[1].split()
                if (data2[0][-1] != ':') and (data2[0] != 'None'):
                    m6 = ET.SubElement(m4, "cel-core:Name")
                    m6.text = data2[0]

            if new_data[i].find("identifier: ") != -1:
                data1 = new_data[i].split("identifier: ")
                data2 = data1[1].split()
                if (data2[0][-1] != ':') and (data2[0] != 'None'):
                    m6 = ET.SubElement(m4, "dc:identifier")
                    m6.text = data2[0]

            if new_data[i].find("description: ") != -1:
                data1 = new_data[i].split("description: ")
                data2 = data1[1].split()
                if (data2[0][-1] != ':') and (data2[0] != 'None'):
                    m6 = ET.SubElement(m4, "dc:description")
                    m6.text = data2[0]

            if new_data[i].find("details: ") != -1:
                data1 = new_data[i].split("details: ")
                if (data1[1][-1] != ':') and (data1[1] != 'None') and (data1[1].find("ns1=") == -1):
                    m6 = ET.SubElement(m4, "cel-core:Details")
                    print(data1)
                    data2 = data1[1].split('\n')
                    m6.text = data2[0]

    m4 = ET.SubElement(root, "cel-core:Body")
    m5 = ET.SubElement(m4, "cel-core:OperativePart")
    NumOfClauses = contr.functions.getNumOfClauses().call()

    for n in range(0, int(NumOfClauses)):
        OPType = contr.functions.getOPType(n).call()
        OPType = str(OPType)
        # DMAF: permissions are cel-ipre:Permission (what models/Body.parse reads); the
        # reference wrote cel-core:Permission, so permissions vanished on re-parse
        OPType = ("cel-ipre:" if OPType == "Permission" else "cel-core:") + OPType
        m6 = ET.SubElement(m5, OPType)
        cId = contr.functions.getCId(n).call()
        if cId != '':
            m6.set('id', cId)

        subject = contr.functions.getOPSubject(n).call()
        m7 = ET.SubElement(m6, "cel-core:Subject", {'partyRef': subject})

        # Act:
        act_relr = contr.functions.getrelr(n).call()
        if act_relr != '':
            m7 = ET.SubElement(m6, "cel-core:Act")
            act2 = act_relr.split(" ")
            act3 = act2[0][0].lower() + act2[0][1:] + act2[1]  # DMAF: rel-r:possessProperty (the parser's spelling)
            relr = "rel-r:"+act3
            m8 = ET.SubElement(m7, relr)

        act = contr.functions.getProvide(n).call()
        if act != '':
            m7 = ET.SubElement(m6, "cel-core:Act")
            m8 = ET.SubElement(m7, "cel-core:Provide")
            m8.set('recipients', act)

        ip = contr.functions.getIncomePercentage(n).call()
        amount = contr.functions.getAmount(n).call()
        beneficiary = contr.functions.getBeneficiary(n).call()
        if beneficiary != '':
            m7 = ET.SubElement(m6, "cel-core:Act")
            m8 = ET.SubElement(m7, "cel-pane:Payment")
            if ip != '':
                m8.set('incomePercentage', ip)
            if amount != '':
                m8.set('amount', amount)
            m9 = ET.SubElement(m8, "cel-pane:Beneficiary")
            m9.set('partyRef', beneficiary)

        # Object:
        OPobject = contr.functions.getOPObject(n).call()
        if OPobject != '':
            name = None
            identifier = None
            relatedidentifier = None
            if OPobject.find("{'name': '") != -1:
                OpOb = OPobject.split("{'name': '")
                OpOb2 = OpOb[1].split("', ", 1)
                name = OpOb2[0]
                if len(OpOb2) > 1 and OpOb2[1].find("'Identifier': '") != -1:
                    OpOb3 = OpOb2[1].split("'Identifier': '")
                    OpOb4 = OpOb3[1].split("'", 1)
                    identifier = OpOb4[0]
                if len(OpOb2) > 1 and OpOb2[1].find("'RelatedIdentifier': '") != -1:
                    OpOb5 = OpOb2[1].split("'RelatedIdentifier': '")
                    OpOb6 = OpOb5[1].split("'", 1)
                    relatedidentifier = OpOb6[0]
            m7 = ET.SubElement(m6, "cel-core:Object")
            if name is not None:
                m8 = ET.SubElement(m7, "cel-core:Item")
                m8.set('name', name)
            if identifier is not None:
                m9 = ET.SubElement(m8, "dii:Identifier")
                m9.text = identifier
            if relatedidentifier is not None:
                m9 = ET.SubElement(m8, "dii:RelatedIdentifier")
                m9.text = relatedidentifier

        # Constraint:
        ce = contr.functions.getCE(n).call()
        if ce != '':
            m7 = ET.SubElement(m6, "cel-core:Constraint")
            deliveryModality = contr.functions.getdeliveryModality(n).call()
            if deliveryModality != '':
                m8 = ET.SubElement(m7, "cel-ipre:DeliveryModality")
                m8.set('href', deliveryModality)

        # Issuer:
        issuer = contr.functions.getOPIssuer(n).call()
        if issuer != '':
            m7 = ET.SubElement(m6, "cel-core:Issuer")
            m7.set('partyRef', issuer)

    indent(root)
    tree = ET.ElementTree(root)
    return ET.tostring(tree.getroot(), encoding='utf8', method='xml')

    '''
    with open(fileName, "wb") as files:
        tree.write(files)
    '''