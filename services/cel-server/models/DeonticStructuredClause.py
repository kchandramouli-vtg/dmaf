import xml.etree.ElementTree as ET
from typing import Dict, List

from models.Act import Act
from models.Constraint import Constraint
from models.Metadata import Metadata
from models.Obj import Obj
from models.PreCondition import PreCondition
from pydantic.main import BaseModel


class DeonticStructuredClause(BaseModel):  # todo : almost done

    data: str = ''
    namespace: Dict[str, str] = {}
    metadata: Metadata = None
    context: str = ''
    precondition: List[PreCondition] = []
    subject_partyRef: str = ''
    act: Act = None
    object = []
    resultantObject: Dict[str, str] = {}
    constraint: Constraint = None
    postcondition: str = ''
    issuer: str = ''
    number: str = ''
    id: str = ''
    deonticType: str = ''
    idrefs: str = ''

    def parse(self):
        deonticStructuredClause = ET.fromstring(self.data)
        attrib = deonticStructuredClause.attrib
        if 'number' in attrib:
            self.number = attrib['number']
        if 'id' in attrib:
            self.id = attrib['id']
        if 'idrefs' in attrib:
            self.idrefs = attrib['idrefs']
        metadata = deonticStructuredClause.find(
            'cel-core:Metadata', self.namespace)
        if metadata is not None:  # DMAF: Element truthiness is len(children)
            self.metadata = Metadata(**{'data': ET.tostring(metadata)
                                     .decode('ascii'), 'namespace': self.namespace})
            self.metadata.parse()
        context = deonticStructuredClause.find(
            'cel-core:Context', self.namespace)
        if context is not None:  # DMAF: Element truthiness is len(children)
            self.context = ET.tostring(context)
        preconditions = deonticStructuredClause.findall(
            'cel-core:PreCondition', self.namespace)
        for i in preconditions:
            precondition = PreCondition(
                **{'data': i, 'namespace': self.namespace})
            precondition.parse()
            self.precondition.append(precondition)

        subject = deonticStructuredClause.find(
            'cel-core:Subject', self.namespace)
        if subject is not None:  # DMAF: Element truthiness is len(children)
            self.subject_partyRef = subject.attrib['partyRef']
        act = deonticStructuredClause.find('cel-core:Act', self.namespace)
        if act is not None:  # DMAF: Element truthiness is len(children)
            self.act = Act(**{'data': ET.tostring(act),
                           'namespace': self.namespace})
            self.act.parse()
        objs = deonticStructuredClause.findall(
            'cel-core:Object', self.namespace)
        for obj in objs:
            o = Obj(**{'data': ET.tostring(obj), 'namespace': self.namespace})
            o.parse()
            self.object.append(o)

        resultantObject = deonticStructuredClause.find(
            'cel-core:ResultantObject/cel-core:Item', self.namespace)
        if resultantObject is not None:  # DMAF: Element truthiness is len(children)
            self.resultantObject['name'] = resultantObject.attrib['name']
            identifier = resultantObject.find('dii:Identifier', self.namespace)
            if identifier is not None:  # DMAF: Element truthiness is len(children)
                self.resultantObject['Identifier'] = identifier.text
            # RelatedIdentifier
            rel_id = resultantObject.find(
                'dii:RelatedIdentifier', self.namespace)
            if rel_id is not None:  # DMAF: Element truthiness is len(children)
                self.resultantObject['RelatedIdentifier'] = rel_id.text
        # Constraint
        constraint = deonticStructuredClause.find(
            'cel-core:Constraint', self.namespace)
        if constraint is not None:  # DMAF: Element truthiness is len(children)
            self.constraint = Constraint(**{
                'data': ET.tostring(constraint), 'namespace': self.namespace})
            self.constraint.parse()
        postcondition = deonticStructuredClause.find(
            'cel-core:PostCondition', self.namespace)
        if postcondition is not None:  # DMAF: Element truthiness is len(children)
            self.postcondition = postcondition.attrib['idref']
        issuer = deonticStructuredClause.find(
            'cel-core:Issuer', self.namespace)
        if issuer is not None:  # DMAF: Element truthiness is len(children)
            self.issuer = issuer.attrib['partyRef']
        self.namespace = None
        self.data = None
