import * as DialogPrimitive from '@radix-ui/react-dialog';
declare const Dialog: import("react").FC<DialogPrimitive.DialogProps>;
declare const DialogTrigger: import("react").ForwardRefExoticComponent<DialogPrimitive.DialogTriggerProps & import("react").RefAttributes<HTMLButtonElement>>;
declare const DialogClose: import("react").ForwardRefExoticComponent<DialogPrimitive.DialogCloseProps & import("react").RefAttributes<HTMLButtonElement>>;
declare function DialogContent({ className, children, ...props }: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>): import("react").JSX.Element;
declare function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): import("react").JSX.Element;
declare function DialogBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): import("react").JSX.Element;
declare function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): import("react").JSX.Element;
declare function DialogTitle({ className, ...props }: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>): import("react").JSX.Element;
declare function DialogDescription({ className, ...props }: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>): import("react").JSX.Element;
export { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger };
//# sourceMappingURL=dialog.d.ts.map