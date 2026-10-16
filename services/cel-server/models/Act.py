import xml.etree.ElementTree as ET
from typing import Dict, List

from pydantic.main import BaseModel

from models.Payment import Payment


class Act(BaseModel):
    data: str = ''
    namespace: Dict[str, str] = {}
    action: str = ''  # todo : not done / not parsed
    id: str = ''
    ref: str = ''
    actionList: List[str] = ['CommunicationToThePublic', 'CreativeTransform', 'Distribute', 'Duplicate', 'ExploitIPRights', 'Fixate', 'MakeAdaptation', 'MakeCopy', 'MakeCutAndEdit', 'MakeExcerpt',
                             'MakeRadioProduct', 'MakeInstance', 'Novelization', 'Prequel', 'PublicCommunication', 'PublicPerformance', 'Remake', 'Remix', 'Sequel', 'Spinoff', 'Translate', 'Transform']
    relr: str = ''   # todo
    provide: List[str] = []
    payment: str = ''
    notify: str = ''  # todo: in cel-pane.xsd finish this

    def parse(self):
        act = ET.fromstring(self.data)
        attrib = act.attrib
        if 'id' in attrib:
            self.id = attrib['id']
        relr = act.find('rel-r:possessProperty', self.namespace)
        if relr is not None:  # DMAF: Element truthiness is len(children)
            self.relr = 'Possess Property'

        provide = act.find('cel-core:Provide', self.namespace)
        if provide is not None:  # DMAF: Element truthiness is len(children)
            attrib = provide.attrib
            if 'recipients' in attrib:
                self.provide.append(attrib['recipients'])
            if 'isOnLoan' in attrib:
                self.provide.append(attrib['isOnLoan'])

        payment = act.find('cel-pane:Payment', self.namespace)
        if payment is not None:  # DMAF: Element truthiness is len(children)
            self.payment = Payment(
                **{'data': ET.tostring(payment), 'namespace': self.namespace})
            self.payment.parse()
        # DMAF: the reference left `action` unparsed ("todo"); record any other
        # act element (cel-ipre:Distribute, rel-mx:play, ...) by its local name.
        handled = {'possessProperty', 'Provide', 'Payment', 'Notify'}
        for child in act:
            local = child.tag.split('}')[-1]
            if local not in handled and not self.action:
                self.action = local
        self.namespace = None
        self.data = None
